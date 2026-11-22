/**
 * Returns the windows an existing appointment can move to. Read-only: nothing here writes,
 * so the agent can offer options without having committed to a change.
 *
 * One of three single-purpose replacements for the old HvacUpdateAppointment. The same
 * ownership bar as the two write actions applies even though this only reads, because the
 * windows are offered for a specific appointment and confirming one exists is itself a
 * disclosure.
 */
public with sharing class HvacGetRescheduleOptions {

    public class Request {
        @InvocableVariable(label='appointmentNumber' description='Confirmation number of the appointment to move.' required=true)
        public String appointmentNumber;

        @InvocableVariable(label='callbackPhone' description='The phone number the appointment was booked under. Required: the last four digits must match the record.' required=true)
        public String callbackPhone;

        @InvocableVariable(label='preferredTimeframe' description='Any preference the caller mentioned, such as mornings, next week, or Friday.')
        public String preferredTimeframe;
    }

    public class Response {
        @InvocableVariable(label='optionsSummary' description='One spoken sentence offering the windows it can move to.')
        public String optionsSummary;

        @InvocableVariable(label='appointmentNumber' description='Appointment confirmation number.')
        public String appointmentNumber;

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

        @InvocableVariable(label='optionsOffered' description='True when windows were returned and can be offered.')
        public Boolean optionsOffered;
    }

    @InvocableMethod(
        label='Get Reschedule Options'
        description='Returns the arrival windows an existing appointment can be moved to, in the service address local time.'
        category='HVAC Voice Agent'
    )
    public static List<Response> getRescheduleOptions(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(getOne(request));
        }
        return responses;
    }

    private static Response getOne(Request request) {
        Response response = new Response();
        response.appointmentNumber = '';
        response.optionOneId = '';
        response.optionOneLabel = '';
        response.optionTwoId = '';
        response.optionTwoLabel = '';
        response.optionThreeId = '';
        response.optionThreeLabel = '';
        response.optionsOffered = false;

        HvacDemoUtil.AppointmentAccess access =
            HvacDemoUtil.resolveAppointment(request.appointmentNumber, request.callbackPhone);
        if (!access.granted) {
            response.optionsSummary = access.refusal;
            return response;
        }

        HVAC_Appointment__c appointment = access.appointment;
        response.appointmentNumber = appointment.Name;

        if (appointment.Status__c == 'Cancelled') {
            response.optionsSummary = 'That appointment is already cancelled, so there is nothing to move.';
            return response;
        }

        List<HvacDemoUtil.Slot> options =
            HvacDemoUtil.nextSlots(appointment.Postal_Code__c, false, request.preferredTimeframe, 3);
        if (options.isEmpty()) {
            response.optionsSummary = 'I do not have another window to move that to right now. '
                + 'On a real call a dispatcher could open one up.';
            return response;
        }

        List<String> labels = new List<String>();
        for (Integer i = 0; i < options.size(); i++) {
            HvacDemoUtil.Slot option = options[i];
            labels.add(option.label);
            if (i == 0) {
                response.optionOneId = option.slotId;
                response.optionOneLabel = option.label;
            } else if (i == 1) {
                response.optionTwoId = option.slotId;
                response.optionTwoLabel = option.label;
            } else {
                response.optionThreeId = option.slotId;
                response.optionThreeLabel = option.label;
            }
        }

        response.optionsOffered = true;
        response.optionsSummary = 'I can move it to ' + String.join(labels, ', or ')
            + '. Those are in the local time of the service address. Which of those works?';
        return response;
    }
}
