/**
 * Reads the demo customer's account balances for the financial services voice agent.
 *
 * There is a single seeded demo customer — the caller is "signed in" as that persona, stated
 * in the greeting — so this reads the seeded FS_Account__c rows directly. It never mutates a
 * balance, including for a provisional credit, so every visitor hears the same figures. It
 * layers one piece of session state on top of the read: if this messaging session has locked
 * the card, the card summary says so.
 *
 * Outputs are flat spoken scalars. Money is formatted by FsDemoUtil.spokenMoney, never with a
 * dollar sign or a comma.
 */
// without sharing: the card-lock reflection below counts this session's own demo lock Cases,
// which the org reassigns to a support queue on insert. A with-sharing context would not see them
// (the agent user is not a queue member) and would silently never reflect a lock. The only query
// is scoped to the DEMOFS|<session>|Card Lock marker, so bypassing sharing exposes nothing else.
public without sharing class FsGetAccountBalances {

    public class Request {
        @InvocableVariable(label='accountName' description='Which account the caller asked about: "checking", "savings", "card", or blank for all three.')
        public String accountName;
        @InvocableVariable(label='sessionId' description='The messaging session id, used only to reflect a card lock made in this session.')
        public String sessionId;
    }

    public class Response {
        @InvocableVariable(label='balanceSummary' description='One or two spoken sentences answering what the caller asked, money in words.')
        public String balanceSummary;
        @InvocableVariable(label='checkingSummary' description='Everyday checking balance and available, spoken.')
        public String checkingSummary;
        @InvocableVariable(label='savingsSummary' description='Savings balance, spoken.')
        public String savingsSummary;
        @InvocableVariable(label='cardSummary' description='Credit card balance, available credit, and minimum due with its due date, spoken.')
        public String cardSummary;
        @InvocableVariable(label='cardIsLocked' description='True only if this session has locked the card. Internal.')
        public Boolean cardIsLocked;
    }

    @InvocableMethod(
        label='Get Account Balances'
        description='Returns the demo customer balances for checking, savings, and the credit card, spoken for a voice reply.'
        category='Financial Services Voice Agent'
    )
    public static List<Response> getBalances(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(getOne(request));
        }
        return responses;
    }

    private static Response getOne(Request request) {
        Response response = new Response();
        response.balanceSummary = '';
        response.checkingSummary = '';
        response.savingsSummary = '';
        response.cardSummary = '';
        response.cardIsLocked = false;

        Map<String, FsDemoUtil.DemoAccount> byType = new Map<String, FsDemoUtil.DemoAccount>();
        for (FsDemoUtil.DemoAccount account : FsDemoUtil.demoAccounts()) {
            byType.put(FsDemoUtil.blankSafe(account.accountType).toLowerCase(), account);
        }

        FsDemoUtil.DemoAccount checking = byType.get('checking');
        FsDemoUtil.DemoAccount savings = byType.get('savings');
        FsDemoUtil.DemoAccount card = byType.get('credit card');

        if (checking != null) {
            response.checkingSummary = 'Your everyday checking is at ' + FsDemoUtil.spokenMoney(checking.currentBalance)
                + ', with ' + FsDemoUtil.spokenMoney(checking.availableBalance) + ' available.';
        }
        if (savings != null) {
            response.savingsSummary = 'Your savings is at ' + FsDemoUtil.spokenMoney(savings.currentBalance) + '.';
        }
        if (card != null) {
            response.cardSummary = 'Your rewards card has a balance of ' + FsDemoUtil.spokenMoney(card.currentBalance)
                + ', with ' + FsDemoUtil.spokenMoney(card.availableBalance) + ' in available credit.';
            if (card.minimumDue != null && card.minimumDue > 0) {
                response.cardSummary += ' The minimum payment of ' + FsDemoUtil.spokenMoney(card.minimumDue)
                    + ' is due ' + FsDemoUtil.spokenInDays(card.dueInDays) + '.';
            }
        }

        // Reflect a card lock made earlier in this same session. This is the one place a read
        // touches the org, so it is wrapped: if the write object is unavailable the balance read
        // must still succeed, just without the lock note.
        String key = FsDemoUtil.blankSafe(request.sessionId);
        if (String.isNotBlank(key)) {
            try {
                String lockPattern = FsDemoUtil.DEMO_CASE_MARKER + '|' + FsDemoUtil.caseSessionKey(key) + '|Card Lock|%';
                Integer locks = [SELECT COUNT() FROM Case WHERE Subject LIKE :lockPattern];
                if (locks > 0) {
                    response.cardIsLocked = true;
                    response.cardSummary += ' Note this card is currently locked at your request.';
                }
            } catch (Exception e) {
                // Reflection is best-effort; leave cardIsLocked false and say nothing about a lock.
            }
        }

        response.balanceSummary = summaryFor(request.accountName, response);
        return response;
    }

    private static String summaryFor(String accountName, Response response) {
        String needle = FsDemoUtil.blankSafe(accountName).toLowerCase();
        if (needle.contains('check')) {
            return response.checkingSummary;
        }
        if (needle.contains('sav')) {
            return response.savingsSummary;
        }
        if (needle.contains('card') || needle.contains('credit')) {
            return response.cardSummary;
        }
        // Blank or unrecognized: give the everyday picture, checking first.
        List<String> parts = new List<String>();
        if (String.isNotBlank(response.checkingSummary)) { parts.add(response.checkingSummary); }
        if (String.isNotBlank(response.savingsSummary)) { parts.add(response.savingsSummary); }
        if (String.isNotBlank(response.cardSummary)) { parts.add(response.cardSummary); }
        return String.join(parts, ' ');
    }
}
