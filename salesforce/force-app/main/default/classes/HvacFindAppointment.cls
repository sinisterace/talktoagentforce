/**
 * Looks up an existing appointment. Read-only, and deliberately narrow: the search is scoped
 * to demo-flagged records and ALWAYS requires a last-four phone match, with the confirmation
 * number as an optional narrowing filter on top. A confirmation number on its own is not
 * proof of ownership -- they are sequential and spoken aloud, so an anonymous caller could
 * otherwise walk them and browse other people's appointments.
 */
public with sharing class HvacFindAppointment {

    public class Request {
        @InvocableVariable(label='appointmentNumber' description='The appointment confirmation number, if the caller has it.')
        public String appointmentNumber;

        @InvocableVariable(label='callbackPhone' description='The phone number the appointment was booked under. Always required: a confirmation number on its own is not enough to look an appointment up.' required=true)
        public String callbackPhone;

        @InvocableVariable(label='callerName' description='Caller first name.')
        public String callerName;
    }

    public class Response {
        @InvocableVariable(label='appointmentSummary' description='One spoken sentence describing the appointment.')
        public String appointmentSummary;

        @InvocableVariable(label='appointmentNumber' description='Appointment confirmation number.')
        public String appointmentNumber;

        @InvocableVariable(label='currentWindow' description='The current arrival window.')
        public String currentWindow;

        @InvocableVariable(label='serviceType' description='The kind of visit.')
        public String serviceType;

        @InvocableVariable(label='wasFound' description='True when exactly one matching appointment was found.')
        public Boolean wasFound;
    }

    @InvocableMethod(
        label='Find Appointment'
        description='Looks up an existing appointment by confirmation number or by the phone number it was booked under.'
        category='HVAC Voice Agent'
    )
    public static List<Response> find(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(findOne(request));
        }
        return responses;
    }

    private static Response findOne(Request request) {
        Response response = new Response();
        response.appointmentNumber = '';
        response.currentWindow = '';
        response.serviceType = '';
        response.wasFound = false;

        String appointmentKey = HvacDemoUtil.normalizeAppointmentNumber(request.appointmentNumber);
        String lastFour = HvacDemoUtil.lastFour(request.callbackPhone);

        // The phone number is the ownership proof, so it is mandatory on every path. Sequential
        // confirmation numbers (HVA-00009 and its neighbours) are trivially guessable by an
        // anonymous caller, so a number alone must never surface a record.
        if (String.isBlank(lastFour)) {
            response.appointmentSummary = 'To pull up an appointment I need the phone number it was booked under, '
                + 'along with the confirmation number if you have it.';
            return response;
        }

        Boolean matchedByPhone = false;
        List<HVAC_Appointment__c> matches = new List<HVAC_Appointment__c>();

        if (String.isNotBlank(appointmentKey)) {
            String numberPhonePattern = '%' + lastFour;
            matches = [
                SELECT Name, Caller_Name__c, Service_Type__c, Appointment_Type__c, Status__c,
                       Scheduled_Window__c, Window_Start__c, Postal_Code__c
                FROM HVAC_Appointment__c
                WHERE Name = :appointmentKey
                  AND Callback_Phone_Masked__c LIKE :numberPhonePattern
                  AND Is_Demo_Record__c = true
                  AND Status__c = 'Scheduled'
                LIMIT 2
            ];
        }

        if (matches.isEmpty()) {
            String phonePattern = '%' + lastFour;
            matches = [
                SELECT Name, Caller_Name__c, Service_Type__c, Appointment_Type__c, Status__c,
                       Scheduled_Window__c, Window_Start__c, Postal_Code__c
                FROM HVAC_Appointment__c
                WHERE Callback_Phone_Masked__c LIKE :phonePattern
                  AND Is_Demo_Record__c = true
                  AND Status__c = 'Scheduled'
                ORDER BY Window_Start__c ASC
                LIMIT 2
            ];
            matchedByPhone = !matches.isEmpty();
        }

        if (matches.isEmpty()) {
            // One wording for every kind of miss -- wrong number, wrong phone, or a number that
            // belongs to somebody else. A caller probing numbers must not be able to tell the
            // difference between "does not exist" and "exists but is not yours".
            // No callback wording: the agent speaks this verbatim, and nothing on this demo line
            // can arrange a call back.
            response.appointmentSummary = 'I could not find a scheduled appointment under that phone number. '
                + 'Let me check the number with you.';
            return response;
        }

        if (matches.size() > 1) {
            response.appointmentSummary = matchedByPhone
                ? 'I found more than one scheduled visit under that phone number. '
                    + 'The confirmation number would tell me which one to change.'
                : 'I found more than one appointment with that confirmation number.';
            return response;
        }

        HVAC_Appointment__c match = matches[0];
        response.appointmentNumber = match.Name;
        response.currentWindow = String.isBlank(match.Scheduled_Window__c) ? '' : match.Scheduled_Window__c;
        response.serviceType = String.isBlank(match.Service_Type__c) ? '' : match.Service_Type__c;
        response.wasFound = true;
        response.appointmentSummary = 'I have a ' + response.serviceType.toLowerCase() + ' visit '
            + response.currentWindow + ', in the local time of the service address.';
        return response;
    }
}
