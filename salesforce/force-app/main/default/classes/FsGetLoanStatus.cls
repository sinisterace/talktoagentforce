/**
 * Reads the demo customer's loan application status. Read-only — the chosen scope is status
 * and next steps on a seeded application, not submission and not document intake, so nothing
 * advances and the demo is identical for every visitor.
 *
 * All dates are rendered from stored day offsets relative to now. The rate is spoken in words.
 * The application number is returned for the agent to read back one digit at a time; no action
 * anywhere consumes it, so it is inert.
 */
public with sharing class FsGetLoanStatus {

    public class Request {
        @InvocableVariable(label='loanType' description='"mortgage", "auto", or blank for whatever application is open.')
        public String loanType;
        @InvocableVariable(label='sessionId' description='The messaging session id.')
        public String sessionId;
    }

    public class Response {
        @InvocableVariable(label='statusSummary' description='Stage and where the application stands, one spoken sentence.')
        public String statusSummary;
        @InvocableVariable(label='outstandingItem' description='Exactly what is still needed, or empty if nothing is outstanding.')
        public String outstandingItem;
        @InvocableVariable(label='nextStepSummary' description='What happens once the outstanding item arrives, with a timeline.')
        public String nextStepSummary;
        @InvocableVariable(label='applicationNumber' description='Application number for read-back, digit by digit.')
        public String applicationNumber;
        @InvocableVariable(label='rateLockSummary' description='Rate spoken in words and days remaining on the lock, or empty.')
        public String rateLockSummary;
        @InvocableVariable(label='applicationFound' description='True when an application matched. Internal.')
        public Boolean applicationFound;
    }

    @InvocableMethod(
        label='Get Loan Status'
        description='Returns the status, outstanding items, next steps, and rate lock for the demo customer loan application, spoken for voice.'
        category='Financial Services Voice Agent'
    )
    public static List<Response> getStatus(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(getOne(request));
        }
        return responses;
    }

    private static Response getOne(Request request) {
        Response response = new Response();
        response.statusSummary = '';
        response.outstandingItem = '';
        response.nextStepSummary = '';
        response.applicationNumber = '';
        response.rateLockSummary = '';
        response.applicationFound = false;

        List<FsDemoUtil.DemoLoan> apps = FsDemoUtil.demoLoans();
        if (apps.isEmpty()) {
            return response;
        }

        String needle = FsDemoUtil.blankSafe(request.loanType).toLowerCase();
        FsDemoUtil.DemoLoan chosen = null;
        if (String.isNotBlank(needle)) {
            for (FsDemoUtil.DemoLoan app : apps) {
                String type = FsDemoUtil.blankSafe(app.loanType).toLowerCase();
                if (type.contains(needle) || needle.contains(type)) {
                    chosen = app;
                    break;
                }
            }
        }
        // No type given, or no match: default to the one still needing attention (has an
        // outstanding item), else the first.
        if (chosen == null) {
            for (FsDemoUtil.DemoLoan app : apps) {
                if (String.isNotBlank(app.outstandingItem)) {
                    chosen = app;
                    break;
                }
            }
        }
        if (chosen == null) {
            chosen = apps[0];
        }

        response.applicationFound = true;
        response.applicationNumber = FsDemoUtil.blankSafe(chosen.applicationNumber);
        response.statusSummary = FsDemoUtil.blankSafe(chosen.statusSummary);
        response.outstandingItem = FsDemoUtil.blankSafe(chosen.outstandingItem);
        response.nextStepSummary = FsDemoUtil.blankSafe(chosen.nextStepSummary);

        if (chosen.ratePercent != null) {
            String rate = FsDemoUtil.spokenPercent(chosen.ratePercent);
            if (chosen.rateLockExpiresInDays != null) {
                response.rateLockSummary = 'Your rate is locked at ' + rate + ', and the lock holds for another '
                    + chosen.rateLockExpiresInDays + ' days.';
            } else {
                response.rateLockSummary = 'Your rate is ' + rate + '.';
            }
        }
        return response;
    }
}
