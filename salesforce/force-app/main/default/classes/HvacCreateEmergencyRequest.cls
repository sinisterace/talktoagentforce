/**
 * Creates the emergency service request after the caller has confirmed the details
 * out loud. Writes one demo-flagged HVAC_Appointment__c and stores only a masked phone.
 */
public with sharing class HvacCreateEmergencyRequest {

    public class Request {
        @InvocableVariable(label='callerName' description='Caller first name.' required=true)
        public String callerName;

        @InvocableVariable(label='callbackPhone' description='Callback phone number.' required=true)
        public String callbackPhone;

        @InvocableVariable(label='serviceAddress' description='Street address and city of the property.' required=true)
        public String serviceAddress;

        @InvocableVariable(label='postalCode' description='Postal code of the service address.' required=true)
        public String postalCode;

        @InvocableVariable(label='issueSummary' description='What the system is doing or not doing.' required=true)
        public String issueSummary;

        @InvocableVariable(label='propertyType' description='residential or commercial.')
        public String propertyType;

        @InvocableVariable(label='hazardReported' description='True if a safety hazard was reported earlier on the call.')
        public Boolean hazardReported;

        @InvocableVariable(label='sessionId' description='Session id used to flag and reset demo records.')
        public String sessionId;
    }

    public class Response {
        @InvocableVariable(label='requestNumber' description='Confirmation number for the emergency request.')
        public String requestNumber;

        @InvocableVariable(label='confirmedWindow' description='Confirmed arrival window.')
        public String confirmedWindow;

        @InvocableVariable(label='technicianName' description='Assigned technician first name.')
        public String technicianName;

        @InvocableVariable(label='wasCreated' description='True when the request was created.')
        public Boolean wasCreated;
    }

    @InvocableMethod(
        label='Create Emergency Service Request'
        description='Creates the emergency service request and returns the confirmation number and arrival window.'
        category='HVAC Voice Agent'
    )
    public static List<Response> create(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(createOne(request));
        }
        return responses;
    }

    private static Response createOne(Request request) {
        Response response = new Response();
        response.requestNumber = '';
        response.confirmedWindow = '';
        response.technicianName = '';
        response.wasCreated = false;

        String postal = HvacDemoUtil.normalizePostal(request.postalCode);
        if (!HvacDemoUtil.inServiceArea(postal)) {
            response.confirmedWindow = '';
            return response;
        }
        if (HvacDemoUtil.sessionCapReached(request.sessionId)) {
            return response;
        }

        String cluster = HvacDemoUtil.clusterFor(postal);
        Boolean commercial = HvacDemoUtil.normalizePropertyType(request.propertyType) == 'Commercial';
        String postalPattern = '%' + postal + '%';

        List<HVAC_Technician__c> technicians = [
            SELECT Id, Name, Serves_Residential__c, Serves_Commercial__c, Earliest_Available_In_Hours__c
            FROM HVAC_Technician__c
            WHERE Metro_Cluster__c = :cluster
              AND Postal_Codes__c LIKE :postalPattern
              AND Available_For_Emergency__c = true
            ORDER BY Earliest_Available_In_Hours__c ASC NULLS LAST
            LIMIT 20
        ];

        // Same cluster-level fallback as the availability check: the seeded postal lists are
        // samples, so anyone inside a served metro still gets a technician.
        if (technicians.isEmpty()) {
            technicians = [
                SELECT Id, Name, Serves_Residential__c, Serves_Commercial__c, Earliest_Available_In_Hours__c
                FROM HVAC_Technician__c
                WHERE Metro_Cluster__c = :cluster
                  AND Available_For_Emergency__c = true
                ORDER BY Earliest_Available_In_Hours__c ASC NULLS LAST
                LIMIT 20
            ];
        }

        // Last resort: anyone on call anywhere. Same reason as the availability check — the
        // seeded metros do not all have both a residential and a commercial technician, and the
        // request has to be creatable for any address a prospect gives.
        if (technicians.isEmpty()) {
            technicians = [
                SELECT Id, Name, Serves_Residential__c, Serves_Commercial__c, Earliest_Available_In_Hours__c
                FROM HVAC_Technician__c
                WHERE Available_For_Emergency__c = true
                ORDER BY Earliest_Available_In_Hours__c ASC NULLS LAST
                LIMIT 20
            ];
        }

        HVAC_Technician__c match = null;
        for (HVAC_Technician__c technician : technicians) {
            Boolean qualified = commercial ? technician.Serves_Commercial__c : technician.Serves_Residential__c;
            if (qualified) {
                match = technician;
                break;
            }
        }
        if (match == null && !technicians.isEmpty()) {
            match = technicians[0];
        }
        if (match == null) {
            return response;
        }

        HvacDemoUtil.Slot window = HvacDemoUtil.emergencyWindow(postal, match.Earliest_Available_In_Hours__c);

        HVAC_Appointment__c appointment = new HVAC_Appointment__c();
        appointment.Caller_Name__c = HvacDemoUtil.truncate(request.callerName, 120);
        appointment.Callback_Phone_Masked__c = HvacDemoUtil.maskPhone(request.callbackPhone);
        appointment.Service_Address__c = HvacDemoUtil.truncate(request.serviceAddress, 255);
        appointment.Postal_Code__c = postal;
        appointment.Property_Type__c = HvacDemoUtil.normalizePropertyType(request.propertyType);
        appointment.Service_Type__c = 'Repair';
        appointment.Appointment_Type__c = 'Emergency';
        appointment.Status__c = 'Scheduled';
        appointment.Issue_Summary__c = HvacDemoUtil.truncate(request.issueSummary, 1000);
        appointment.Hazard_Reported__c = request.hazardReported == true;
        appointment.Technician_Name__c = match.Name;
        appointment.Time_Zone__c = window.timeZoneName;
        appointment.Scheduled_Window__c = HvacDemoUtil.truncate(window.label, 255);
        appointment.Slot_Id__c = window.slotId;
        appointment.Window_Start__c = window.windowStart;
        appointment.Window_End__c = window.windowEnd;
        HvacDemoUtil.stampDemo(appointment, request.sessionId);

        insert appointment;

        HVAC_Appointment__c created = [
            SELECT Name, Scheduled_Window__c, Technician_Name__c
            FROM HVAC_Appointment__c
            WHERE Id = :appointment.Id
            LIMIT 1
        ];

        response.requestNumber = created.Name;
        response.confirmedWindow = created.Scheduled_Window__c;
        response.technicianName = created.Technician_Name__c;
        response.wasCreated = true;
        return response;
    }
}
