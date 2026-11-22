/**
 * Reschedules or cancels an existing appointment. Only touches demo-flagged records,
 * and applies the published two-hour cutoff and trip charge.
 */
public with sharing class HvacUpdateAppointment {

    public class Request {
        @InvocableVariable(label='appointmentNumber' description='Confirmation number of the appointment to change.' required=true)
        public String appointmentNumber;

        @InvocableVariable(label='changeType' description='Either reschedule or cancel.' required=true)
        public String changeType;

        @InvocableVariable(label='callbackPhone' description='The phone number the appointment was booked under. Required: the last four digits must match the record before anything is changed.' required=true)
        public String callbackPhone;

        @InvocableVariable(label='newSlotId' description='The new slot token, when rescheduling.')
        public String newSlotId;

        @InvocableVariable(label='reason' description='Why the caller is changing it.')
        public String reason;
    }

    public class Response {
        @InvocableVariable(label='changeSummary' description='One spoken sentence confirming the change.')
        public String changeSummary;

        @InvocableVariable(label='appointmentNumber' description='Appointment confirmation number.')
        public String appointmentNumber;

        @InvocableVariable(label='newWindow' description='The new window, empty on a cancellation.')
        public String newWindow;

        @InvocableVariable(label='wasUpdated' description='True when the appointment was changed.')
        public Boolean wasUpdated;

        @InvocableVariable(label='optionOneId' description='Slot token for the first window we can move it to.')
        public String optionOneId;

        @InvocableVariable(label='optionOneLabel' description='Natural language first window.')
        public String optionOneLabel;

        @InvocableVariable(label='optionTwoId' description='Slot token for the second window.')
        public String optionTwoId;

        @InvocableVariable(label='optionTwoLabel' description='Natural language second window.')
        public String optionTwoLabel;

        @InvocableVariable(label='optionThreeId' description='Slot token for the third window.')
        public String optionThreeId;

        @InvocableVariable(label='optionThreeLabel' description='Natural language third window.')
        public String optionThreeLabel;
    }

    @InvocableMethod(
        label='Change Appointment'
        description='Reschedules or cancels an existing appointment.'
        category='HVAC Voice Agent'
    )
    public static List<Response> applyChange(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(updateOne(request));
        }
        return responses;
    }

    private static Response updateOne(Request request) {
        Response response = new Response();
        response.appointmentNumber = '';
        response.newWindow = '';
        response.wasUpdated = false;
        response.optionOneId = '';
        response.optionOneLabel = '';
        response.optionTwoId = '';
        response.optionTwoLabel = '';
        response.optionThreeId = '';
        response.optionThreeLabel = '';

        String appointmentKey = HvacDemoUtil.normalizeAppointmentNumber(request.appointmentNumber);
        if (String.isBlank(appointmentKey)) {
            response.changeSummary = 'I need the appointment confirmation number before I can change anything.';
            return response;
        }

        // Ownership check. Confirmation numbers are sequential and spoken aloud, so knowing one
        // is not proof of ownership -- anyone on a public link could walk HVA-00001..N and cancel
        // other callers' visits. The caller must also produce the phone the visit was booked
        // under. Enforced here, not only in the agent script, so no amount of talking the planner
        // out of a step can reach the DML.
        String lastFour = HvacDemoUtil.lastFour(request.callbackPhone);
        if (String.isBlank(lastFour)) {
            response.changeSummary = 'Before I change that visit I need the phone number it was booked under.';
            return response;
        }

        List<HVAC_Appointment__c> matches = [
            SELECT Id, Name, Postal_Code__c, Service_Type__c, Status__c, Scheduled_Window__c,
                   Window_Start__c, Window_End__c, Slot_Id__c, Time_Zone__c, Callback_Phone_Masked__c
            FROM HVAC_Appointment__c
            WHERE Name = :appointmentKey AND Is_Demo_Record__c = true
            LIMIT 1
        ];
        if (matches.isEmpty()) {
            response.changeSummary = 'I could not find an appointment with that confirmation number.';
            return response;
        }

        HVAC_Appointment__c appointment = matches[0];

        if (!HvacDemoUtil.phoneMatchesRecord(appointment.Callback_Phone_Masked__c, lastFour)) {
            // Deliberately the same wording as a miss on the number, so a caller probing
            // numbers learns nothing about which ones exist.
            response.changeSummary = 'That confirmation number and phone number do not match an appointment I can change. '
                + 'Let me check them with you again.';
            return response;
        }

        response.appointmentNumber = appointment.Name;

        if (appointment.Status__c == 'Cancelled') {
            response.changeSummary = 'That appointment is already cancelled.';
            return response;
        }

        Boolean insideCutoff = appointment.Window_Start__c != null
            && appointment.Window_Start__c < Datetime.now().addHours(2);
        String tripCharge = insideCutoff
            ? ' Because this is inside two hours of the window, a fifty nine dollar trip charge applies.'
            : ' There is no charge for this change.';

        String change = String.isBlank(request.changeType) ? '' : request.changeType.toLowerCase();

        if (change.contains('cancel')) {
            appointment.Status__c = 'Cancelled';
            appointment.Change_Reason__c = HvacDemoUtil.truncate(request.reason, 500);
            update appointment;
            response.wasUpdated = true;
            response.changeSummary = 'That visit is cancelled.' + tripCharge;
            return response;
        }

        HvacDemoUtil.Slot slot = HvacDemoUtil.slotFromId(request.newSlotId, appointment.Postal_Code__c);
        if (slot == null) {
            List<HvacDemoUtil.Slot> options = HvacDemoUtil.nextSlots(appointment.Postal_Code__c, false, null, 3);
            if (options.isEmpty()) {
                response.changeSummary = 'I do not have another window to move that to right now.';
                return response;
            }
            List<String> labels = new List<String>();
            for (HvacDemoUtil.Slot option : options) {
                labels.add(option.label);
            }
            response.optionOneId = options[0].slotId;
            response.optionOneLabel = options[0].label;
            if (options.size() > 1) {
                response.optionTwoId = options[1].slotId;
                response.optionTwoLabel = options[1].label;
            }
            if (options.size() > 2) {
                response.optionThreeId = options[2].slotId;
                response.optionThreeLabel = options[2].label;
            }
            response.changeSummary = 'I can move it to ' + String.join(labels, ', or ')
                + '. Which of those works?';
            return response;
        }

        if (slot.windowStart < Datetime.now()) {
            response.changeSummary = 'That window has already passed. Let me offer another one.';
            return response;
        }

        appointment.Slot_Id__c = slot.slotId;
        appointment.Window_Start__c = slot.windowStart;
        appointment.Window_End__c = slot.windowEnd;
        appointment.Scheduled_Window__c = HvacDemoUtil.truncate(slot.label, 255);
        appointment.Time_Zone__c = slot.timeZoneName;
        appointment.Change_Reason__c = HvacDemoUtil.truncate(request.reason, 500);
        update appointment;

        response.wasUpdated = true;
        response.newWindow = slot.label;
        response.changeSummary = 'That visit is moved to ' + slot.label + '.' + tripCharge;
        return response;
    }
}
