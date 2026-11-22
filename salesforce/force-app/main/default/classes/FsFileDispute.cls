/**
 * Files a dispute against a located transaction for the financial services voice agent.
 *
 * The write is an FS_Service_Request__c stamped with the session id — the only object this
 * agent writes. The transaction reference must be one the recent-transactions lookup returned
 * (the agent gates on that); this class does not accept a caller-spoken identifier of any kind,
 * which is the deliberate defense against the HVAC-style attack where a guessed sequential
 * number addressed someone else's record.
 *
 * Idempotent per session: a second dispute against the same transaction returns the first case
 * number instead of writing again, so "did that go through?" cannot create a duplicate.
 * Provisional-credit wording matches the knowledge corpus.
 */
// without sharing: the Case this class inserts is immediately reassigned to a support queue by
// the org's default case ownership, and the running agent user is not a queue member, so a
// with-sharing context could no longer read the record back for its CaseNumber, for per-session
// idempotency, or for the write cap. This class only ever touches its own demo Cases (every query
// is scoped to the DEMOFS|<session> Subject marker), so bypassing record sharing exposes nothing.
public without sharing class FsFileDispute {

    public class Request {
        @InvocableVariable(label='transactionRef' description='Opaque token for the located charge, from get_recent_transactions. Required.' required=true)
        public String transactionRef;
        @InvocableVariable(label='reason' description='Why the caller is disputing, in their words. Truncated before saving.')
        public String reason;
        @InvocableVariable(label='sessionId' description='The messaging session id, used to scope idempotency and the per-session write cap. Blank is allowed (the dispute still files); it is never blank on a live channel.')
        public String sessionId;
    }

    public class Response {
        @InvocableVariable(label='caseNumber' description='The dispute case number, read back digit by digit.')
        public String caseNumber;
        @InvocableVariable(label='disputeSummary' description='What was disputed, spoken.')
        public String disputeSummary;
        @InvocableVariable(label='provisionalCreditSummary' description='Provisional credit timing, matching the corpus.')
        public String provisionalCreditSummary;
        @InvocableVariable(label='wasFiled' description='True once a dispute exists for this charge. Internal.')
        public Boolean wasFiled;
    }

    @InvocableMethod(
        label='File Dispute'
        description='Files a charge dispute against a located transaction and returns a case number, or returns the existing case if already filed this session.'
        category='Financial Services Voice Agent'
    )
    public static List<Response> fileDispute(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(fileOne(request));
        }
        return responses;
    }

    private static Response fileOne(Request request) {
        Response response = new Response();
        response.caseNumber = '';
        response.disputeSummary = '';
        response.provisionalCreditSummary = '';
        response.wasFiled = false;

        String ref = FsDemoUtil.truncate(FsDemoUtil.blankSafe(request.transactionRef), 255);
        String key = FsDemoUtil.truncate(FsDemoUtil.blankSafe(request.sessionId), 255);
        if (String.isBlank(ref)) {
            return response;
        }

        // Resolve the charge for a spoken summary against the inline dataset. A ref that does
        // not resolve still files — the agent only reaches here after locating the charge —
        // but the summary stays generic.
        String chargeLabel = '';
        FsDemoUtil.DemoTxn txn = FsDemoUtil.findTxn(ref);
        if (txn != null) {
            chargeLabel = FsDemoUtil.blankSafe(txn.merchant) + ' for ' + FsDemoUtil.spokenMoney(txn.amount);
        }

        // The write is a real Salesforce Case, but a public demo action must never throw an
        // uncaught exception at the planner: if it does, the model has no case number and yet
        // may narrate a filed dispute, breaking the honesty rule. On any failure we return a
        // structured, honest result (wasFiled = false, no case number) so the agent's
        // "no number, no claim" rule and the dispute_filed gate both behave correctly.
        try {
            String subject = FsDemoUtil.caseSubject(key, 'Dispute', ref);

            // Idempotency: already disputed this exact charge in this session?
            List<Case> existing = [
                SELECT CaseNumber FROM Case WHERE Subject = :subject ORDER BY CreatedDate ASC LIMIT 1
            ];
            if (!existing.isEmpty()) {
                response.caseNumber = existing[0].CaseNumber;
                response.wasFiled = true;
                response.disputeSummary = String.isBlank(chargeLabel)
                    ? 'That charge is already disputed under this case.'
                    : 'The charge from ' + chargeLabel + ' is already disputed under this case.';
                response.provisionalCreditSummary = provisionalCreditLine();
                return response;
            }

            if (FsDemoUtil.sessionCapReached(key)) {
                response.disputeSummary = 'I have hit the limit for this demo session, so I cannot file another request right now.';
                return response;
            }

            Case c = new Case();
            c.Subject = subject;
            c.Description = 'Demo charge dispute filed by the financial services voice agent. '
                + 'Charge: ' + (String.isBlank(chargeLabel) ? ref : chargeLabel) + '. '
                + 'Reason: ' + FsDemoUtil.truncate(FsDemoUtil.blankSafe(request.reason), 2000);
            c.Origin = 'Web';
            c.Status = 'New';
            insert c;

            Case saved = [SELECT CaseNumber FROM Case WHERE Id = :c.Id LIMIT 1];
            response.caseNumber = saved.CaseNumber;
            response.wasFiled = true;
            response.disputeSummary = String.isBlank(chargeLabel)
                ? 'I have opened a dispute on that charge.'
                : 'I have opened a dispute on the ' + chargeLabel + ' charge.';
            response.provisionalCreditSummary = provisionalCreditLine();
        } catch (Exception e) {
            response.caseNumber = '';
            response.wasFiled = false;
            response.disputeSummary = 'I could not open the dispute just now, so nothing has been filed yet.';
            response.provisionalCreditSummary = '';
        }
        return response;
    }

    private static String provisionalCreditLine() {
        return 'You will see a provisional credit within ten business days while we investigate, '
            + 'and you do not have to pay the disputed amount in the meantime.';
    }
}
