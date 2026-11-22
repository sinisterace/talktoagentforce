/**
 * Checks whether a technician covers a postal code and when they could arrive.
 * Read-only. Every arrival window is expressed in the service address's local time.
 */
public with sharing class HvacCheckTechnicianAvailability {

    public class Request {
        @InvocableVariable(label='postalCode' description='Postal code of the service address.' required=true)
        public String postalCode;

        @InvocableVariable(label='propertyType' description='residential or commercial.')
        public String propertyType;

        @InvocableVariable(label='issueSummary' description='What the system is doing or not doing.')
        public String issueSummary;
    }

    public class Response {
        @InvocableVariable(label='availabilityMessage' description='A spoken sentence describing coverage and arrival.')
        public String availabilityMessage;

        @InvocableVariable(label='technicianName' description='First name of the available technician.')
        public String technicianName;

        @InvocableVariable(label='dispatchWindow' description='Natural language arrival window in the property local time.')
        public String dispatchWindow;

        @InvocableVariable(label='isAvailable' description='True when a technician can be dispatched.')
        public Boolean isAvailable;

        @InvocableVariable(label='inServiceArea' description='True when the postal code is covered at all.')
        public Boolean inServiceArea;

        // Echoed back so the agent stores the same postal code this check ran against, rather
        // than extracting it a second time from the conversation. A caller who corrects their
        // address mid-call would otherwise get a coverage answer for one place and a booking
        // for another.
        @InvocableVariable(label='resolvedPostalCode' description='The postal code this check actually used.')
        public String resolvedPostalCode;
    }

    @InvocableMethod(
        label='Check Technician Availability'
        description='Finds an available technician for a postal code and returns a spoken arrival window in the service location local time.'
        category='HVAC Voice Agent'
    )
    public static List<Response> check(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request request : requests) {
            responses.add(checkOne(request));
        }
        return responses;
    }

    private static Response checkOne(Request request) {
        Response response = new Response();
        response.technicianName = '';
        response.dispatchWindow = '';
        response.isAvailable = false;
        response.inServiceArea = false;
        response.resolvedPostalCode = '';

        String postal = HvacDemoUtil.normalizePostal(request.postalCode);
        response.resolvedPostalCode = postal;
        if (!HvacDemoUtil.isCompletePostal(postal)) {
            // Same reason as the options lookup: name the one thing to re-ask for, and do not
            // assume five digits, because the caller may not be in the US.
            response.availabilityMessage = 'I did not catch the whole postal code for the service address. '
                + 'Ask them to repeat just the postal code, nothing else.';
            response.resolvedPostalCode = '';
            return response;
        }

        String cluster = HvacDemoUtil.clusterFor(postal);
        if (cluster == null) {
            // No callback wording anywhere in these strings: the agent speaks them verbatim, and
            // nothing on this demo line can arrange a call back.
            response.availabilityMessage = 'That postal code is outside our service area, so I cannot promise a technician. '
                + 'On a real call this is where a dispatcher would route you to a partner contractor who covers your area.';
            return response;
        }
        response.inServiceArea = true;

        Boolean commercial = HvacDemoUtil.normalizePropertyType(request.propertyType) == 'Commercial';
        String postalPattern = '%' + postal + '%';

        List<HVAC_Technician__c> technicians = [
            SELECT Id, Name, Postal_Codes__c, Metro_Cluster__c, Serves_Residential__c,
                   Serves_Commercial__c, Available_For_Emergency__c, Earliest_Available_In_Hours__c
            FROM HVAC_Technician__c
            WHERE Metro_Cluster__c = :cluster
              AND Postal_Codes__c LIKE :postalPattern
              AND Available_For_Emergency__c = true
            ORDER BY Earliest_Available_In_Hours__c ASC NULLS LAST
            LIMIT 20
        ];

        // Fall back to anyone covering the metro cluster: the seeded postal lists are samples,
        // and a caller in a served metro should not be told we cannot come out.
        if (technicians.isEmpty()) {
            technicians = [
                SELECT Id, Name, Postal_Codes__c, Metro_Cluster__c, Serves_Residential__c,
                       Serves_Commercial__c, Available_For_Emergency__c, Earliest_Available_In_Hours__c
                FROM HVAC_Technician__c
                WHERE Metro_Cluster__c = :cluster
                  AND Available_For_Emergency__c = true
                ORDER BY Earliest_Available_In_Hours__c ASC NULLS LAST
                LIMIT 20
            ];
        }

        // Last resort: anyone on call anywhere. Some seeded metros only have a residential or
        // only a commercial technician, and a caller should not be refused because of which
        // sample rows happen to exist. Emergency dispatch is the whole point of this path.
        if (technicians.isEmpty()) {
            technicians = [
                SELECT Id, Name, Postal_Codes__c, Metro_Cluster__c, Serves_Residential__c,
                       Serves_Commercial__c, Available_For_Emergency__c, Earliest_Available_In_Hours__c
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
        // Nobody with the exact residential or commercial certification: take whoever is on call
        // rather than end the conversation. This is a demo line, not a real dispatch board.
        if (match == null && !technicians.isEmpty()) {
            match = technicians[0];
        }

        if (match == null) {
            String who = commercial ? 'commercial certified technician' : 'residential technician';
            response.availabilityMessage = 'I do not have a ' + who + ' open right now. '
                + 'On a real call a dispatcher could pull someone in.';
            return response;
        }

        HvacDemoUtil.Slot window = HvacDemoUtil.emergencyWindow(postal, match.Earliest_Available_In_Hours__c);
        response.isAvailable = true;
        response.technicianName = match.Name;
        response.dispatchWindow = window.label;

        String surcharge = HvacDemoUtil.isAfterHours(postal)
            ? ' Because this is outside regular hours, there is a one hundred forty five dollar after hours dispatch surcharge, waived for Comfort Care Plus and Commercial Priority members.'
            : '';
        response.availabilityMessage = match.Name + ' can be there ' + window.label + '.' + surcharge;
        return response;
    }
}
