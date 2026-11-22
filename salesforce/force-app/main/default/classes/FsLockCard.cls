/**
 * Locks the demo customer's card and, when asked, orders a replacement.
 *
 * One action for both, because a caller reporting a lost card asks for one thing. The write is
 * an FS_Service_Request__c stamped with the session id. Idempotent per session: a second call
 * returns the first confirmation number and wasLocked = true without writing again, so the
 * fraud-response gate that locks before anything else cannot double-write on a follow-up turn.
 *
 * Replacement arrival wording matches the knowledge corpus (five to seven business days
 * standard, one to two expedited).
 */
// without sharing: the Case this class inserts is immediately reassigned to a support queue by
// the org's default case ownership, and the running agent user is not a queue member, so a
// with-sharing context could no longer read the record back for its CaseNumber or for the
// per-session idempotency lookup. This class only ever touches its own demo Cases (every query is
// scoped to the DEMOFS|<session> Subject marker), so bypassing record sharing exposes nothing.
public without sharing class FsLockCard {

    public class Request {
        @InvocableVariable(label='orderReplacement' description='True if the caller wants a new card sent.')
        public Boolean orderReplacement;
        @InvocableVariable(label='reason' description='Why the caller is locking the card, in their words. Truncated before saving.')
        public String reason;
        @InvocableVariable(label='sessionId' description='The messaging session id, used to scope idempotency and the per-session write cap. Blank is allowed (the lock still applies); it is never blank on a live channel.')
        public String sessionId;
    }

    public class Response {
        @InvocableVariable(label='confirmationNumber' description='The lock confirmation number, read back digit by digit.')
        public String confirmationNumber;
        @InvocableVariable(label='lockSummary' description='What is now blocked and what still works, spoken.')
        public String lockSummary;
        @InvocableVariable(label='replacementSummary' description='Replacement arrival window, matching the corpus, or empty if none ordered.')
        public String replacementSummary;
        @InvocableVariable(label='wasLocked' description='True once the card is locked. Internal.')
        public Boolean wasLocked;
    }

    @InvocableMethod(
        label='Lock Card'
        description='Locks the demo customer card and optionally orders a replacement, returning a confirmation number. Idempotent within a session.'
        category='Financial Services Voice Agent'
    )
    public static List<Response> lockCard(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(lockOne(request));
        }
        return responses;
    }

    private static Response lockOne(Request request) {
        Response response = new Response();
        response.confirmationNumber = '';
        response.lockSummary = '';
        response.replacementSummary = '';
        response.wasLocked = false;

        Boolean wantsReplacement = request.orderReplacement == true;
        String key = FsDemoUtil.truncate(FsDemoUtil.blankSafe(request.sessionId), 255);

        // The write is a real Salesforce record, but a public demo action must never throw an
        // uncaught exception at the planner: if it does, the model has no confirmation number
        // and yet may narrate a success, breaking the honesty rule. On any failure we return a
        // structured, honest result (wasLocked = false, no confirmation number) so the agent's
        // "no number, no claim" rule and the card_secured gate both behave correctly.
        try {
            // A single card lock per session, regardless of the replacement flag: the fraud
            // gate can call this on more than one turn, and both a plain lock and a
            // lock-with-replacement are the same underlying action. So idempotency matches on
            // the lock type alone (marker|session|Card Lock|), and a later replacement request
            // updates the same Case rather than opening a second one.
            String lockPattern = FsDemoUtil.DEMO_CASE_MARKER + '|' + FsDemoUtil.caseSessionKey(key) + '|Card Lock|%';
            List<Case> existing = [
                SELECT CaseNumber, Subject FROM Case WHERE Subject LIKE :lockPattern ORDER BY CreatedDate ASC LIMIT 1
            ];
            if (!existing.isEmpty()) {
                response.confirmationNumber = existing[0].CaseNumber;
                response.wasLocked = true;
                response.lockSummary = 'Your card is already locked. New purchases and ATM withdrawals are blocked; '
                    + 'any payments you have already scheduled still go through.';
                Boolean alreadyHadReplacement = existing[0].Subject != null && existing[0].Subject.contains('replacement');
                if (alreadyHadReplacement) {
                    response.replacementSummary = replacementLine();
                } else if (wantsReplacement) {
                    // They locked earlier without a replacement and now want one; note it on the same Case.
                    Case toUpdate = new Case(Id = [SELECT Id FROM Case WHERE Subject = :existing[0].Subject LIMIT 1].Id);
                    toUpdate.Subject = FsDemoUtil.caseSubject(key, 'Card Lock', 'replacement');
                    update toUpdate;
                    response.replacementSummary = replacementLine();
                }
                return response;
            }

            if (FsDemoUtil.sessionCapReached(key)) {
                response.lockSummary = 'I have hit the limit for this demo session, so I cannot file another request right now.';
                return response;
            }

            Case c = new Case();
            c.Subject = FsDemoUtil.caseSubject(key, 'Card Lock', wantsReplacement ? 'replacement' : 'lock only');
            c.Description = 'Demo card lock filed by the financial services voice agent. '
                + 'Replacement ordered: ' + (wantsReplacement ? 'yes' : 'no') + '. '
                + 'Reason: ' + FsDemoUtil.truncate(FsDemoUtil.blankSafe(request.reason), 2000);
            c.Origin = 'Web';
            c.Status = 'New';
            insert c;

            Case saved = [SELECT CaseNumber FROM Case WHERE Id = :c.Id LIMIT 1];
            response.confirmationNumber = saved.CaseNumber;
            response.wasLocked = true;
            response.lockSummary = 'Your card is now locked. New purchases, ATM withdrawals, and cash advances are blocked; '
                + 'any payments you have already scheduled still go through, and you can unlock it any time.';
            if (wantsReplacement) {
                response.replacementSummary = replacementLine();
            }
        } catch (Exception e) {
            response.confirmationNumber = '';
            response.wasLocked = false;
            response.lockSummary = 'I could not complete the lock just now, so the card is not secured yet.';
            response.replacementSummary = '';
        }
        return response;
    }

    private static String replacementLine() {
        return 'A replacement is on its way by standard mail in five to seven business days at no charge. '
            + 'It will have a new number, so anything set to bill this card automatically will need updating once it arrives.';
    }
}
