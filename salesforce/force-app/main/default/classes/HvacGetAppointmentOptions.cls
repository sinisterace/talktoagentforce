/**
 * Returns three real arrival windows for a postal code, computed from the current
 * moment in the service address's own time zone. Read-only.
 */
public with sharing class HvacGetAppointmentOptions {

    public class Request {
        @InvocableVariable(label='postalCode' description='Postal code of the service address.' required=true)
        public String postalCode;

        @InvocableVariable(label='serviceType' description='tune_up, maintenance, inspection or repair.' required=true)
        public String serviceType;

        @InvocableVariable(label='preferredTimeframe' description='Any preference the caller mentioned, such as mornings, next week, or Friday.')
        public String preferredTimeframe;
    }

    public class Response {
        @InvocableVariable(label='optionsSummary' description='One spoken sentence offering the three windows.')
        public String optionsSummary;

        @InvocableVariable(label='optionOneId' description='Slot token for the first window.')
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

        @InvocableVariable(label='inServiceArea' description='True when the postal code is covered.')
        public Boolean inServiceArea;

        // Echoed back so the booking stores the same postal code these windows were computed
        // for, rather than extracting it a second time. The windows are in that postal code's
        // time zone, so a second extraction disagreeing would offer windows for another city.
        @InvocableVariable(label='resolvedPostalCode' description='The postal code these windows were computed for.')
        public String resolvedPostalCode;
    }

    @InvocableMethod(
        label='Get Appointment Options'
        description='Returns three available arrival windows for a postal code, computed from the current time in the property local time zone.'
        category='HVAC Voice Agent'
    )
    public static List<Response> getOptions(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(getOne(request));
        }
        return responses;
    }

    private static Response getOne(Request request) {
        Response response = new Response();
        response.optionOneId = '';
        response.optionOneLabel = '';
        response.optionTwoId = '';
        response.optionTwoLabel = '';
        response.optionThreeId = '';
        response.optionThreeLabel = '';
        response.optionsOffered = false;
        response.inServiceArea = false;
        response.resolvedPostalCode = '';

        String postal = HvacDemoUtil.normalizePostal(request.postalCode);
        if (!HvacDemoUtil.isCompletePostal(postal)) {
            // Says what to ask for, because left to improvise the agent asks callers to spell the
            // whole address out digit by digit, which is a miserable way to start a demo. No
            // "five digits" here: the caller may well have given a Canadian or British code.
            response.optionsSummary = 'I did not catch the whole postal code for the service address. '
                + 'Ask them to repeat just the postal code, nothing else.';
            return response;
        }
        response.resolvedPostalCode = postal;
        if (!HvacDemoUtil.inServiceArea(postal)) {
            // No callback wording anywhere in these strings: the agent speaks them verbatim, and
            // nothing on this demo line can arrange a call back.
            response.optionsSummary = 'That postal code is outside our service area, so I do not have windows to offer. '
                + 'On a real call this is where a dispatcher would route you to a partner contractor who covers your area.';
            return response;
        }
        response.inServiceArea = true;

        // Commercial work is scheduled in the morning windows by default; the caller's
        // property type reaches this action through the service type they described.
        Boolean commercial = String.isNotBlank(request.serviceType)
            && request.serviceType.toLowerCase().contains('commercial');

        List<HvacDemoUtil.Slot> slots = HvacDemoUtil.nextSlots(postal, commercial, request.preferredTimeframe, 3);
        if (slots.isEmpty()) {
            response.optionsSummary = 'I do not have an open window to offer right now. '
                + 'On a real call a dispatcher could open up a slot or find you a partner contractor.';
            return response;
        }

        List<String> labels = new List<String>();
        for (Integer i = 0; i < slots.size(); i++) {
            HvacDemoUtil.Slot slot = slots[i];
            labels.add(slot.label);
            if (i == 0) {
                response.optionOneId = slot.slotId;
                response.optionOneLabel = slot.label;
            } else if (i == 1) {
                response.optionTwoId = slot.slotId;
                response.optionTwoLabel = slot.label;
            } else {
                response.optionThreeId = slot.slotId;
                response.optionThreeLabel = slot.label;
            }
        }

        String serviceType = HvacDemoUtil.normalizeServiceType(request.serviceType);
        String joined = String.join(labels, ', or ');
        response.optionsSummary = 'For a ' + serviceType.toLowerCase() + ' visit I have ' + joined
            + '. All of those are in the local time of the service address.';
        response.optionsOffered = true;
        return response;
    }
}
