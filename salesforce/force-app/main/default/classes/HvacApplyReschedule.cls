/**
 * Moves an existing appointment to a window the caller picked. Only touches demo-flagged
 * records, and quotes the published two-hour trip charge.
 *
 * One of three single-purpose replacements for the old HvacUpdateAppointment. This one only
 * ever applies a window: it requires a slot token that came back from
 * HvacGetRescheduleOptions rather than a spoken time, and refuses instead of quietly
 * offering alternatives, so the agent cannot arrive here without the caller having chosen.
 */
public with sharing class HvacApplyReschedule {

    public class Request {
        @InvocableVariable(label='appointmentNumber' description='Confirmation number of the appointment to move.' required=true)
        public String appointmentNumber;

        @InvocableVariable(label='callbackPhone' description='The phone number the appointment was booked under. Required: the last four digits must match the record before anything is moved.' required=true)
        public String callbackPhone;

        @InvocableVariable(label='newSlotId' description='The slot token for the window the caller chose, exactly as it came back from the reschedule options.' required=true)
        public String newSlotId;

        @InvocableVariable(label='reason' description='Why the caller is moving it.')
        public String reason;
    }

    public class Response {
        @InvocableVariable(label='rescheduleSummary' description='One spoken sentence confirming the new window.')
        public String rescheduleSummary;

        @InvocableVariable(label='appointmentNumber' description='Appointment confirmation number.')
        public String appointmentNumber;

        @InvocableVariable(label='newWindow' description='The new arrival window.')
        public String newWindow;

        @InvocableVariable(label='wasRescheduled' description='True when the appointment was moved.')
        public Boolean wasRescheduled;
    }

    @InvocableMethod(
        label='Apply Reschedule'
        description='Moves an existing appointment to a window the caller chose from the offered options.'
        category='HVAC Voice Agent'
    )
    public static List<Response> applyReschedule(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(applyOne(request));
        }
        return responses;
    }

    private static Response applyOne(Request request) {
        Response response = new Response();
        response.appointmentNumber = '';
        response.newWindow = '';
        response.wasRescheduled = false;

        HvacDemoUtil.AppointmentAccess access =
            HvacDemoUtil.resolveAppointment(request.appointmentNumber, request.callbackPhone);
        if (!access.granted) {
            response.rescheduleSummary = access.refusal;
            return response;
        }

        HVAC_Appointment__c appointment = access.appointment;
        response.appointmentNumber = appointment.Name;

        if (appointment.Status__c == 'Cancelled') {
            response.rescheduleSummary = 'That appointment is already cancelled, so there is nothing to move.';
            return response;
        }

        // Rebuilt from the token rather than from anything spoken, so a misheard time cannot
        // become a booking. No token means the caller has not actually chosen a window yet.
        HvacDemoUtil.Slot slot = HvacDemoUtil.slotFromId(request.newSlotId, appointment.Postal_Code__c);
        if (slot == null) {
            response.rescheduleSummary = 'I do not have a window to move that to yet. '
                + 'Let me read you the windows it can move to first.';
            return response;
        }

        if (slot.windowStart < Datetime.now()) {
            response.rescheduleSummary = 'That window has already passed. Let me offer another one.';
            return response;
        }

        // Read the charge against the window it is leaving, before the write overwrites it.
        String tripCharge = HvacDemoUtil.tripChargeSentence(appointment);

        appointment.Slot_Id__c = slot.slotId;
        appointment.Window_Start__c = slot.windowStart;
        appointment.Window_End__c = slot.windowEnd;
        appointment.Scheduled_Window__c = HvacDemoUtil.truncate(slot.label, 255);
        appointment.Time_Zone__c = slot.timeZoneName;
        appointment.Change_Reason__c = HvacDemoUtil.truncate(request.reason, 500);
        update appointment;

        response.wasRescheduled = true;
        response.newWindow = slot.label;
        response.rescheduleSummary = 'That visit is moved to ' + slot.label + '.' + tripCharge;
        return response;
    }
}
