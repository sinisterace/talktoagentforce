/**
 * Books the arrival window the caller chose. The window is rebuilt from the slot token,
 * never from a spoken time, so the agent cannot book something it never offered.
 */
public with sharing class HvacBookAppointment {

    public class Request {
        @InvocableVariable(label='callerName' description='Caller first name.' required=true)
        public String callerName;

        @InvocableVariable(label='callbackPhone' description='Callback phone number.' required=true)
        public String callbackPhone;

        @InvocableVariable(label='serviceAddress' description='Street address and city of the property.' required=true)
        public String serviceAddress;

        @InvocableVariable(label='postalCode' description='Postal code of the service address.' required=true)
        public String postalCode;

        @InvocableVariable(label='serviceType' description='tune_up, maintenance, inspection or repair.' required=true)
        public String serviceType;

        @InvocableVariable(label='slotId' description='The slot token for the window the caller chose.' required=true)
        public String slotId;

        @InvocableVariable(label='sessionId' description='Session id used to flag and reset demo records.')
        public String sessionId;
    }

    public class Response {
        @InvocableVariable(label='appointmentNumber' description='Appointment confirmation number.')
        public String appointmentNumber;

        @InvocableVariable(label='confirmedWindow' description='Confirmed arrival window.')
        public String confirmedWindow;

        @InvocableVariable(label='wasCreated' description='True when the appointment was booked.')
        public Boolean wasCreated;
    }

    @InvocableMethod(
        label='Book Appointment'
        description='Books the chosen arrival window and returns the appointment confirmation number.'
        category='HVAC Voice Agent'
    )
    public static List<Response> book(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(bookOne(request));
        }
        return responses;
    }

    private static Response bookOne(Request request) {
        Response response = new Response();
        response.appointmentNumber = '';
        response.confirmedWindow = '';
        response.wasCreated = false;

        String postal = HvacDemoUtil.normalizePostal(request.postalCode);
        if (!HvacDemoUtil.inServiceArea(postal)) {
            return response;
        }
        if (HvacDemoUtil.sessionCapReached(request.sessionId)) {
            return response;
        }

        HvacDemoUtil.Slot slot = HvacDemoUtil.slotFromId(request.slotId, postal);
        if (slot == null || slot.windowStart < Datetime.now()) {
            return response;
        }

        List<HVAC_Appointment__c> conflicts = [
            SELECT Id FROM HVAC_Appointment__c
            WHERE Slot_Id__c = :slot.slotId AND Status__c = 'Scheduled'
            LIMIT 1
        ];
        if (!conflicts.isEmpty()) {
            return response;
        }

        HVAC_Appointment__c appointment = new HVAC_Appointment__c();
        appointment.Caller_Name__c = HvacDemoUtil.truncate(request.callerName, 120);
        appointment.Callback_Phone_Masked__c = HvacDemoUtil.maskPhone(request.callbackPhone);
        appointment.Service_Address__c = HvacDemoUtil.truncate(request.serviceAddress, 255);
        appointment.Postal_Code__c = postal;
        appointment.Property_Type__c = HvacDemoUtil.normalizePropertyType(request.serviceType);
        appointment.Service_Type__c = HvacDemoUtil.normalizeServiceType(request.serviceType);
        appointment.Appointment_Type__c = 'Scheduled';
        appointment.Status__c = 'Scheduled';
        appointment.Time_Zone__c = slot.timeZoneName;
        appointment.Scheduled_Window__c = HvacDemoUtil.truncate(slot.label, 255);
        appointment.Slot_Id__c = slot.slotId;
        appointment.Window_Start__c = slot.windowStart;
        appointment.Window_End__c = slot.windowEnd;
        HvacDemoUtil.stampDemo(appointment, request.sessionId);

        insert appointment;

        HVAC_Appointment__c created = [
            SELECT Name, Scheduled_Window__c FROM HVAC_Appointment__c
            WHERE Id = :appointment.Id LIMIT 1
        ];

        response.appointmentNumber = created.Name;
        response.confirmedWindow = created.Scheduled_Window__c;
        response.wasCreated = true;
        return response;
    }
}
