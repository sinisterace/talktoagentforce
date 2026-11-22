/**
 * Shared helpers for the Financial Services Voice Agent demo actions.
 *
 * Not an invocable action. It holds the logic every action class needs: spoken-language
 * money and percentage formatting, relative-date rendering, input truncation, demo-record
 * stamping, and the per-session write cap that keeps a public demo link from filling the org.
 *
 * Two rules shape the formatting, both learned on the HVAC agent:
 *  - Money is spoken with a plain integer and the word "dollars" — never a dollar sign and
 *    never a digit-grouping comma. TTS reads "$1,150" as "dollar one one five zero"; it reads
 *    "1150 dollars" correctly. Cents, when present, are spoken as "and NN cents".
 *  - Dates are rendered relative to the moment of the call from a stored day offset, so the
 *    demo never goes stale. Nothing in the org stores an absolute date for this agent.
 */
// without sharing: sessionCapReached counts this session's demo Cases, which the org reassigns to
// a support queue on insert; a with-sharing count would miss them and under-enforce the cap. Every
// query here is scoped to the DEMOFS|<session> Subject marker, so bypassing sharing exposes nothing.
public without sharing class FsDemoUtil {

    public static final Integer MAX_WRITES_PER_SESSION = 3;

    // ------------------------------------------------------------------ formatting

    /**
     * "4218 dollars", or "4218 dollars and 37 cents" when there are cents. No dollar sign,
     * no comma — see the class comment. A null amount returns an empty string so a summary
     * can leave the figure out rather than say "null dollars".
     */
    public static String spokenMoney(Decimal amount) {
        if (amount == null) {
            return '';
        }
        Decimal abs = amount.abs();
        Long dollars = (abs.setScale(0, System.RoundingMode.DOWN)).longValue();
        Integer cents = ((abs - dollars) * 100).setScale(0, System.RoundingMode.HALF_UP).intValue();
        // A rounding edge can push cents to 100; carry it into dollars.
        if (cents == 100) {
            dollars += 1;
            cents = 0;
        }
        String sign = amount < 0 ? 'negative ' : '';
        String dollarWord = dollars == 1 ? ' dollar' : ' dollars';
        if (cents == 0) {
            return sign + dollars + dollarWord;
        }
        String centWord = cents == 1 ? ' cent' : ' cents';
        return sign + dollars + dollarWord + ' and ' + cents + centWord;
    }

    /**
     * "six point two five percent" from 6.25. Spelled to words because a bare "6.25 percent"
     * is usually read correctly, but a trailing-zero rate like 6.20 is read as "six point two"
     * and sounds wrong next to a written rate — spelling every digit keeps it unambiguous.
     */
    public static String spokenPercent(Decimal rate) {
        if (rate == null) {
            return '';
        }
        // Two decimal places is how a rate is quoted; drop a trailing zero so 6.20 -> "six
        // point two", which is how a person says it, while 6.25 keeps both digits.
        String text = rate.setScale(2).toPlainString();
        if (text.endsWith('0') && text.contains('.')) {
            text = text.substring(0, text.length() - 1);
        }
        if (text.endsWith('.')) {
            text = text.substring(0, text.length() - 1);
        }
        List<String> words = new List<String>();
        for (Integer i = 0; i < text.length(); i++) {
            String ch = text.substring(i, i + 1);
            if (ch == '.') {
                words.add('point');
            } else {
                words.add(DIGIT_WORDS.get(ch));
            }
        }
        return String.join(words, ' ') + ' percent';
    }

    private static final Map<String, String> DIGIT_WORDS = new Map<String, String>{
        '0' => 'zero', '1' => 'one', '2' => 'two', '3' => 'three', '4' => 'four',
        '5' => 'five', '6' => 'six', '7' => 'seven', '8' => 'eight', '9' => 'nine'
    };

    /**
     * A day offset into spoken relative language, computed from now. 0 is "today", 1 is
     * "yesterday", two-to-six days back names the weekday ("on Monday"), and anything older
     * is "N days ago". Naming the weekday for the recent past is how a person refers to a
     * charge from earlier in the week; a raw "5 days ago" for everything sounds robotic.
     */
    public static String spokenDaysAgo(Integer daysAgo) {
        if (daysAgo == null || daysAgo < 0) {
            return 'recently';
        }
        if (daysAgo == 0) {
            return 'today';
        }
        if (daysAgo == 1) {
            return 'yesterday';
        }
        if (daysAgo <= 6) {
            return 'on ' + Datetime.now().addDays(-daysAgo).format('EEEE');
        }
        return daysAgo + ' days ago';
    }

    /** Forward-looking counterpart: 0 "today", 1 "tomorrow", else "in N days". */
    public static String spokenInDays(Integer days) {
        if (days == null || days < 0) {
            return 'soon';
        }
        if (days == 0) {
            return 'today';
        }
        if (days == 1) {
            return 'tomorrow';
        }
        return 'in ' + days + ' days';
    }

    // ------------------------------------------------------------------ input hygiene

    public static String truncate(String value, Integer maxLength) {
        if (String.isBlank(value)) {
            return '';
        }
        String trimmed = value.trim();
        return trimmed.length() <= maxLength ? trimmed : trimmed.substring(0, maxLength);
    }

    public static String blankSafe(String value) {
        return String.isBlank(value) ? '' : value.trim();
    }

    // ------------------------------------------------------------------ demo writes

    /**
     * The two write actions (a dispute and a card lock) create a standard Case. Everything the
     * demo needs to recognize its own rows, scope them to one session, and enforce idempotency
     * is encoded in the Case Subject as marker|session|type|detail, because Subject is short,
     * filterable, and LIKE-searchable. The Case's own auto-numbered CaseNumber is the human
     * confirmation number read back to the caller. (A custom object was the original design, but
     * its fields would not materialize in this org's runtime; a standard object always does.)
     */
    public static final String DEMO_CASE_MARKER = 'DEMOFS';

    /** Session truncated the same way everywhere a Subject or a LIKE pattern is built. */
    public static String caseSessionKey(String sessionId) {
        return truncate(blankSafe(sessionId), 80);
    }

    /** marker|session|type|detail — the exact Subject written and matched on for idempotency. */
    public static String caseSubject(String sessionId, String reqType, String detail) {
        return DEMO_CASE_MARKER + '|' + caseSessionKey(sessionId) + '|' + reqType + '|' + truncate(blankSafe(detail), 60);
    }

    /** marker|session|% — matches every demo Case this session has written, for the cap. */
    public static String caseSessionPattern(String sessionId) {
        return DEMO_CASE_MARKER + '|' + caseSessionKey(sessionId) + '|%';
    }

    /**
     * A public demo link means anyone can hammer the two write actions. Three cases per
     * messaging session is enough to show a dispute and a card lock and not enough to be a
     * problem. A blank session (as in preview) is never capped.
     */
    public static Boolean sessionCapReached(String sessionId) {
        if (String.isBlank(sessionId)) {
            return false;
        }
        String pattern = caseSessionPattern(sessionId);
        Integer written = [SELECT COUNT() FROM Case WHERE Subject LIKE :pattern];
        return written >= MAX_WRITES_PER_SESSION;
    }

    // ------------------------------------------------------------------ demo data (inline)

    /**
     * The read-only demo dataset lives here as constants, not as org records: every visitor
     * hears identical figures, so there is nothing to seed and nothing to keep in sync. The
     * only thing this agent writes to the org is FS_Service_Request__c (a dispute or a card
     * lock). Amounts are plain Decimals — spoken formatting happens at read time. Dates are
     * day offsets rendered relative to now, so the demo never ages.
     */

    public class DemoAccount {
        public String accountType;      // 'checking' | 'savings' | 'credit card'
        public String lastFour;
        public Decimal currentBalance;
        public Decimal availableBalance;
        public Decimal minimumDue;      // null unless a card
        public Integer dueInDays;       // null unless a card
        public DemoAccount(String t, String l4, Decimal cur, Decimal avail, Decimal minDue, Integer due) {
            accountType = t; lastFour = l4; currentBalance = cur; availableBalance = avail;
            minimumDue = minDue; dueInDays = due;
        }
    }

    public static List<DemoAccount> demoAccounts() {
        return new List<DemoAccount>{
            new DemoAccount('checking', '4419', 4218.37, 4218.37, null, null),
            new DemoAccount('savings', '8802', 15640.00, 15640.00, null, null),
            new DemoAccount('credit card', '3067', 1284.52, 8715.48, 35.00, 12)
        };
    }

    public class DemoTxn {
        public String ref;              // synthetic stable token, e.g. 'TXN-CC-1'
        public String accountType;      // 'checking' | 'credit card'
        public String merchant;
        public Decimal amount;
        public Integer daysAgo;
        public String direction;        // 'debit' | 'credit'
        public DemoTxn(String r, String t, String m, Decimal a, Integer d, String dir) {
            ref = r; accountType = t; merchant = m; amount = a; daysAgo = d; direction = dir;
        }
    }

    /**
     * Card activity first (where disputes usually live), then checking, each ordered
     * most-recent first. "QuickPay Digital Svc" is the deliberately unrecognizable charge the
     * dispute flow targets. The ref is a synthetic token, never spoken; the agent passes it
     * into file_dispute, which resolves it back through findTxn.
     */
    public static List<DemoTxn> demoTransactions() {
        return new List<DemoTxn>{
            new DemoTxn('TXN-CC-1', 'credit card', 'QuickPay Digital Svc', 89.99, 2, 'debit'),
            new DemoTxn('TXN-CC-2', 'credit card', 'Riverside Grocery', 63.18, 3, 'debit'),
            new DemoTxn('TXN-CC-3', 'credit card', 'Summit Coffee House', 6.75, 4, 'debit'),
            new DemoTxn('TXN-CC-4', 'credit card', 'Metro Gas and Go', 47.40, 6, 'debit'),
            new DemoTxn('TXN-CC-5', 'credit card', 'Northgate Pharmacy', 24.10, 9, 'debit'),
            new DemoTxn('TXN-CHK-1', 'checking', 'Payroll Direct Deposit', 2450.00, 1, 'credit'),
            new DemoTxn('TXN-CHK-2', 'checking', 'Cedar Ridge Apartments', 1650.00, 3, 'debit'),
            new DemoTxn('TXN-CHK-3', 'checking', 'City Power and Light', 112.86, 5, 'debit'),
            new DemoTxn('TXN-CHK-4', 'checking', 'Streamly Subscription', 15.99, 7, 'debit')
        };
    }

    /** Resolve a synthetic transaction ref back to its record, or null if it does not match. */
    public static DemoTxn findTxn(String ref) {
        if (String.isBlank(ref)) {
            return null;
        }
        for (DemoTxn t : demoTransactions()) {
            if (t.ref == ref) {
                return t;
            }
        }
        return null;
    }

    public class DemoLoan {
        public String applicationNumber;
        public String loanType;         // 'Mortgage' | 'Auto'
        public String stage;
        public String statusSummary;
        public String outstandingItem;  // blank when nothing is outstanding
        public String nextStepSummary;
        public Integer submittedDaysAgo;
        public Decimal ratePercent;
        public Integer rateLockExpiresInDays;   // null when there is no active lock
        public DemoLoan(String appNum, String t, String st, String status, String outstanding,
                        String next, Integer submitted, Decimal rate, Integer lockDays) {
            applicationNumber = appNum; loanType = t; stage = st; statusSummary = status;
            outstandingItem = outstanding; nextStepSummary = next; submittedDaysAgo = submitted;
            ratePercent = rate; rateLockExpiresInDays = lockDays;
        }
    }

    /**
     * The mortgage is the primary beat: in underwriting, waiting on one document, rate locked.
     * The auto loan is the second beat: already approved, nothing outstanding. Application
     * numbers are inert — read back digit by digit, but no action consumes them.
     */
    public static List<DemoLoan> demoLoans() {
        return new List<DemoLoan>{
            new DemoLoan('LN-100482', 'Mortgage', 'Underwriting',
                'Your mortgage application is in underwriting and moving along well.',
                'a current pay stub',
                'Once that pay stub is in, underwriting takes about three business days, and then you get a decision.',
                18, 6.25, 12),
            new DemoLoan('LN-100517', 'Auto', 'Approved',
                'Your auto loan is approved and ready for the funds to be released once you finalize with the dealer.',
                '',
                'Nothing is needed from you; the dealer coordinates the payoff and the funds release.',
                25, 5.90, null)
        };
    }
}
