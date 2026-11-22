/**
 * Cancels an existing appointment. Only touches demo-flagged records, and quotes the
 * published two-hour trip charge.
 *
 * One of three single-purpose replacements for the old HvacUpdateAppointment, which
 * decided between cancelling, offering windows and applying a window from a changeType
 * string the planner filled in. Splitting them means the planner picks the outcome by
 * picking the action, and each one can be gated separately in the agent script.
 */
public with sharing class HvacCancelAppointment {

    public class Request {
        @InvocableVariable(label='appointmentNumber' description='Confirmation number of the appointment to cancel.' required=true)
        public String appointmentNumber;

        @InvocableVariable(label='callbackPhone' description='The phone number the appointment was booked under. Required: the last four digits must match the record before anything is cancelled.' required=true)
        public String callbackPhone;

        @InvocableVariable(label='reason' description='Why the caller is cancelling.')
        public String reason;
    }

    public class Response {
        @InvocableVariable(label='cancelSummary' description='One spoken sentence confirming the cancellation.')
        public String cancelSummary;

        @InvocableVariable(label='appointmentNumber' description='Appointment confirmation number.')
        public String appointmentNumber;

        @InvocableVariable(label='wasCancelled' description='True when the appointment was cancelled.')
        public Boolean wasCancelled;
    }

    @InvocableMethod(
        label='Cancel Appointment'
        description='Cancels an existing appointment after checking the phone number it was booked under.'
        category='HVAC Voice Agent'
    )
    public static List<Response> cancelAppointment(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(cancelOne(request));
        }
        return responses;
    }

    private static Response cancelOne(Request request) {
        Response response = new Response();
        response.appointmentNumber = '';
        response.wasCancelled = false;

        HvacDemoUtil.AppointmentAccess access =
            HvacDemoUtil.resolveAppointment(request.appointmentNumber, request.callbackPhone);
        if (!access.granted) {
            response.cancelSummary = access.refusal;
            return response;
        }

        HVAC_Appointment__c appointment = access.appointment;
        response.appointmentNumber = appointment.Name;

        if (appointment.Status__c == 'Cancelled') {
            response.cancelSummary = 'That appointment is already cancelled.';
            return response;
        }

        // Read the charge before the write: the sentence depends on how close the window
        // still is, and cancelling does not move it.
        String tripCharge = HvacDemoUtil.tripChargeSentence(appointment);

        appointment.Status__c = 'Cancelled';
        appointment.Change_Reason__c = HvacDemoUtil.truncate(request.reason, 500);
        update appointment;

        response.wasCancelled = true;
        response.cancelSummary = 'That visit is cancelled.' + tripCharge;
        return response;
    }
}
