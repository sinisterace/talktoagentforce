/**
 * Reads recent activity for the demo customer, and — when the caller describes a charge — tries
 * to pin down the one they mean so a dispute can be filed against a real located transaction.
 *
 * Dates come from a stored day offset (FS_Transaction__c.Days_Ago__c) and are rendered relative
 * to now, so the demo never ages. Amounts are spoken in words. The opaque row Ids are returned
 * but never spoken; the agent passes matchedRef into file_dispute.
 *
 * merchantHint matching is deliberately conservative: exactly one match sets matchFound = true
 * and returns it; zero or two-plus leaves matchFound = false so the agent asks which one rather
 * than disputing the wrong charge.
 */
public with sharing class FsGetRecentTransactions {

    public class Request {
        @InvocableVariable(label='accountName' description='Which account: "checking" or "card". Blank means the card, where disputes usually live.')
        public String accountName;
        @InvocableVariable(label='merchantHint' description='What the caller called the charge they do not recognize, if any.')
        public String merchantHint;
        @InvocableVariable(label='sessionId' description='The messaging session id.')
        public String sessionId;
    }

    public class Response {
        @InvocableVariable(label='transactionsSummary' description='The three most recent charges as one spoken sentence, dates relative, amounts in words.')
        public String transactionsSummary;
        @InvocableVariable(label='oneLabel') public String oneLabel;
        @InvocableVariable(label='twoLabel') public String twoLabel;
        @InvocableVariable(label='threeLabel') public String threeLabel;
        @InvocableVariable(label='oneRef' description='Opaque token for charge one. Never spoken.') public String oneRef;
        @InvocableVariable(label='twoRef' description='Opaque token for charge two. Never spoken.') public String twoRef;
        @InvocableVariable(label='threeRef' description='Opaque token for charge three. Never spoken.') public String threeRef;
        @InvocableVariable(label='matchedLabel' description='Set when merchantHint identified exactly one charge, spoken back to confirm.')
        public String matchedLabel;
        @InvocableVariable(label='matchedRef' description='Token for the matched charge, passed to file_dispute. Never spoken.')
        public String matchedRef;
        @InvocableVariable(label='matchFound' description='True only when merchantHint matched exactly one charge. Internal.')
        public Boolean matchFound;
    }

    @InvocableMethod(
        label='Get Recent Transactions'
        description='Returns the demo customer recent transactions, and locates a single charge when the caller describes one to dispute.'
        category='Financial Services Voice Agent'
    )
    public static List<Response> getTransactions(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(getOne(request));
        }
        return responses;
    }

    private static Response getOne(Request request) {
        Response response = new Response();
        response.transactionsSummary = '';
        response.oneLabel = '';  response.oneRef = '';
        response.twoLabel = '';  response.twoRef = '';
        response.threeLabel = ''; response.threeRef = '';
        response.matchedLabel = ''; response.matchedRef = '';
        response.matchFound = false;

        String needle = FsDemoUtil.blankSafe(request.accountName).toLowerCase();
        // Savings has no card-style activity in the demo; treat it and blank as the card, where
        // disputes live. Only an explicit "checking" narrows to the checking ledger.
        String accountFilter = needle.contains('check') ? 'checking' : 'credit card';

        List<FsDemoUtil.DemoTxn> txns = new List<FsDemoUtil.DemoTxn>();
        for (FsDemoUtil.DemoTxn txn : FsDemoUtil.demoTransactions()) {
            if (FsDemoUtil.blankSafe(txn.accountType).toLowerCase() == accountFilter) {
                txns.add(txn);
            }
        }
        // If nothing matched the requested ledger, fall back to everything.
        if (txns.isEmpty()) {
            txns = FsDemoUtil.demoTransactions();
        }

        List<String> spokenTop = new List<String>();
        for (Integer i = 0; i < txns.size() && i < 3; i++) {
            String label = labelFor(txns[i]);
            if (i == 0) { response.oneLabel = label; response.oneRef = txns[i].ref; }
            if (i == 1) { response.twoLabel = label; response.twoRef = txns[i].ref; }
            if (i == 2) { response.threeLabel = label; response.threeRef = txns[i].ref; }
            spokenTop.add(label);
        }
        response.transactionsSummary = spokenTop.isEmpty()
            ? 'I do not see any recent activity on that account.'
            : String.join(spokenTop, '; ') + '.';

        // Locate a single charge if the caller described one.
        String needleHint = FsDemoUtil.blankSafe(request.merchantHint).toLowerCase();
        if (String.isNotBlank(needleHint)) {
            List<FsDemoUtil.DemoTxn> hits = new List<FsDemoUtil.DemoTxn>();
            for (FsDemoUtil.DemoTxn txn : txns) {
                String merchant = FsDemoUtil.blankSafe(txn.merchant).toLowerCase();
                if (merchant.contains(needleHint) || needleHint.contains(merchant)) {
                    hits.add(txn);
                }
            }
            if (hits.size() == 1) {
                response.matchFound = true;
                response.matchedLabel = labelFor(hits[0]);
                response.matchedRef = hits[0].ref;
            }
        }
        return response;
    }

    private static String labelFor(FsDemoUtil.DemoTxn txn) {
        return FsDemoUtil.blankSafe(txn.merchant) + ', ' + FsDemoUtil.spokenMoney(txn.amount)
            + ', ' + FsDemoUtil.spokenDaysAgo(txn.daysAgo);
    }
}
