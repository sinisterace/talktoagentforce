/**
 * Seeds the HVAC voice agent demo data: technicians across four metro clusters
 * (four different US time zones), the published service plan catalog, and a
 * couple of scheduled appointments so reschedule and cancel can be exercised.
 *
 * Idempotent: deletes prior demo rows before inserting.
 */

delete [SELECT Id FROM HVAC_Appointment__c WHERE Is_Demo_Record__c = true];
delete [SELECT Id FROM HVAC_Technician__c];
delete [SELECT Id FROM HVAC_Service_Plan__c];

// ---------------------------------------------------------------- technicians
List<HVAC_Technician__c> techs = new List<HVAC_Technician__c>();

techs.add(new HVAC_Technician__c(
    Name = 'Ray Delgado',
    Metro_Cluster__c = 'Phoenix Metro',
    Time_Zone__c = 'America/Phoenix',
    Postal_Codes__c = '85001,85004,85008,85016,85251,85254,85301',
    Serves_Residential__c = true,
    Serves_Commercial__c = false,
    Available_For_Emergency__c = true,
    Earliest_Available_In_Hours__c = 2,
    Skills__c = 'Heat pumps, split systems, refrigerant leaks'
));
techs.add(new HVAC_Technician__c(
    Name = 'Priya Raman',
    Metro_Cluster__c = 'Phoenix Metro',
    Time_Zone__c = 'America/Phoenix',
    Postal_Codes__c = '85008,85034,85040,85226,85281,85301',
    Serves_Residential__c = true,
    Serves_Commercial__c = true,
    Available_For_Emergency__c = true,
    Earliest_Available_In_Hours__c = 4,
    Skills__c = 'Rooftop units, chillers, controls'
));
techs.add(new HVAC_Technician__c(
    Name = 'Marcus Webb',
    Metro_Cluster__c = 'Dallas Fort Worth',
    Time_Zone__c = 'America/Chicago',
    Postal_Codes__c = '75001,75006,75038,75201,75204,75220,75252',
    Serves_Residential__c = true,
    Serves_Commercial__c = true,
    Available_For_Emergency__c = true,
    Earliest_Available_In_Hours__c = 3,
    Skills__c = 'Furnaces, gas heat, zoning'
));
techs.add(new HVAC_Technician__c(
    Name = 'Dana Whitfield',
    Metro_Cluster__c = 'Dallas Fort Worth',
    Time_Zone__c = 'America/Chicago',
    Postal_Codes__c = '75201,75210,75234,75240,75063',
    Serves_Residential__c = false,
    Serves_Commercial__c = true,
    Available_For_Emergency__c = true,
    Earliest_Available_In_Hours__c = 6,
    Skills__c = 'Commercial rooftop units, boilers, building automation'
));
techs.add(new HVAC_Technician__c(
    Name = 'Tobias Nkemelu',
    Metro_Cluster__c = 'Atlanta Metro',
    Time_Zone__c = 'America/New_York',
    Postal_Codes__c = '30002,30030,30060,30075,30303,30309,30328,30338',
    Serves_Residential__c = true,
    Serves_Commercial__c = true,
    Available_For_Emergency__c = true,
    Earliest_Available_In_Hours__c = 2,
    Skills__c = 'Air handlers, humidity control, ductwork'
));
techs.add(new HVAC_Technician__c(
    Name = 'Sloane Pettigrew',
    Metro_Cluster__c = 'Seattle Metro',
    Time_Zone__c = 'America/Los_Angeles',
    Postal_Codes__c = '98004,98008,98052,98101,98109,98122,98177,98402',
    Serves_Residential__c = true,
    Serves_Commercial__c = false,
    Available_For_Emergency__c = true,
    Earliest_Available_In_Hours__c = 5,
    Skills__c = 'Ductless mini splits, heat pumps, indoor air quality'
));
insert techs;

// --------------------------------------------------------------- plan catalog
List<HVAC_Service_Plan__c> plans = new List<HVAC_Service_Plan__c>();

plans.add(new HVAC_Service_Plan__c(
    Name = 'Basic Care',
    Property_Type__c = 'Residential',
    Tier_Rank__c = 1,
    Annual_Price__c = 189,
    Price_Unit__c = 'a year',
    Inclusions__c = 'It covers one seasonal tune up a year, a standard filter change at that visit, '
        + 'and ten percent off any repair parts.',
    Renewal_Terms__c = 'Basic Care renews once a year on the anniversary of the start date, '
        + 'and it can be cancelled any time before the renewal date with no penalty.',
    Diagnostic_Fee_Text__c = 'The diagnostic fee on a service call is eighty nine dollars.',
    Next_Tier_Plan_Name__c = 'Comfort Care'
));
plans.add(new HVAC_Service_Plan__c(
    Name = 'Comfort Care',
    Property_Type__c = 'Residential',
    Tier_Rank__c = 2,
    Annual_Price__c = 329,
    Price_Unit__c = 'a year',
    Inclusions__c = 'It covers two tune ups a year, heating and cooling, priority scheduling, '
        + 'filters included, and fifteen percent off repair parts.',
    Renewal_Terms__c = 'Comfort Care renews once a year on the anniversary of the start date, '
        + 'and it can be cancelled any time before the renewal date with no penalty.',
    Diagnostic_Fee_Text__c = 'The diagnostic fee is waived on the first service call each year.',
    Next_Tier_Plan_Name__c = 'Comfort Care Plus'
));
plans.add(new HVAC_Service_Plan__c(
    Name = 'Comfort Care Plus',
    Property_Type__c = 'Residential',
    Tier_Rank__c = 3,
    Annual_Price__c = 549,
    Price_Unit__c = 'a year',
    Inclusions__c = 'It covers two tune ups a year, no overtime charges on after hours emergencies, '
        + 'same day priority dispatch, filters included, and twenty percent off repair parts.',
    Renewal_Terms__c = 'Comfort Care Plus renews once a year on the anniversary of the start date, '
        + 'and it can be cancelled any time before the renewal date with no penalty.',
    Diagnostic_Fee_Text__c = 'Diagnostic fees are waived on all service calls.',
    Next_Tier_Plan_Name__c = ''
));
plans.add(new HVAC_Service_Plan__c(
    Name = 'Commercial Standard',
    Property_Type__c = 'Commercial',
    Tier_Rank__c = 1,
    Annual_Price__c = 1150,
    Price_Unit__c = 'a year per unit',
    Inclusions__c = 'It covers quarterly preventive maintenance on each rooftop unit, belt and filter '
        + 'changes, coil cleaning, and a next business day response target.',
    Renewal_Terms__c = 'Commercial Standard runs on a twelve month term and renews on the anniversary '
        + 'of the start date, with thirty days notice to cancel.',
    Diagnostic_Fee_Text__c = 'Labor during business hours is billed at the plan rate.',
    Next_Tier_Plan_Name__c = 'Commercial Priority'
));
plans.add(new HVAC_Service_Plan__c(
    Name = 'Commercial Priority',
    Property_Type__c = 'Commercial',
    Tier_Rank__c = 2,
    Annual_Price__c = 1875,
    Price_Unit__c = 'a year per unit',
    Inclusions__c = 'It covers quarterly preventive maintenance, a four hour emergency response target, '
        + 'no after hours labor charges, and refrigerant included up to five pounds a year.',
    Renewal_Terms__c = 'Commercial Priority runs on a twelve month term and renews on the anniversary '
        + 'of the start date, with thirty days notice to cancel.',
    Diagnostic_Fee_Text__c = 'There is no diagnostic fee on covered equipment.',
    Next_Tier_Plan_Name__c = ''
));
insert plans;

// ------------------------------------------------------- test appointments
// Real future windows, computed the same way the agent computes them, so a
// reschedule or cancel in the demo hits a record whose window math is valid.
List<HVAC_Appointment__c> appointments = new List<HVAC_Appointment__c>();

List<HvacDemoUtil.Slot> phx = HvacDemoUtil.nextSlots('85016', false, null, 3);
if (!phx.isEmpty()) {
    HvacDemoUtil.Slot slot = phx[phx.size() - 1];
    HVAC_Appointment__c appointment = new HVAC_Appointment__c(
        Caller_Name__c = 'Jordan',
        Callback_Phone_Masked__c = 'xxx-xxx-4417',
        Service_Address__c = '2140 East Camelback Road, Phoenix',
        Postal_Code__c = '85016',
        Property_Type__c = 'Residential',
        Service_Type__c = 'Tune Up',
        Appointment_Type__c = 'Scheduled',
        Status__c = 'Scheduled',
        Scheduled_Window__c = slot.label,
        Slot_Id__c = slot.slotId,
        Window_Start__c = slot.windowStart,
        Window_End__c = slot.windowEnd,
        Time_Zone__c = slot.timeZoneName,
        Technician_Name__c = 'Ray Delgado'
    );
    HvacDemoUtil.stampDemo(appointment, 'SEED-SESSION-PHX');
    appointments.add(appointment);
}

List<HvacDemoUtil.Slot> atl = HvacDemoUtil.nextSlots('30309', true, null, 3);
if (!atl.isEmpty()) {
    HvacDemoUtil.Slot slot = atl[atl.size() - 1];
    HVAC_Appointment__c appointment = new HVAC_Appointment__c(
        Caller_Name__c = 'Renee',
        Callback_Phone_Masked__c = 'xxx-xxx-2088',
        Service_Address__c = '1100 Peachtree Street Northeast, Atlanta',
        Postal_Code__c = '30309',
        Property_Type__c = 'Commercial',
        Service_Type__c = 'Maintenance',
        Appointment_Type__c = 'Scheduled',
        Status__c = 'Scheduled',
        Scheduled_Window__c = slot.label,
        Slot_Id__c = slot.slotId,
        Window_Start__c = slot.windowStart,
        Window_End__c = slot.windowEnd,
        Time_Zone__c = slot.timeZoneName,
        Technician_Name__c = 'Tobias Nkemelu'
    );
    HvacDemoUtil.stampDemo(appointment, 'SEED-SESSION-ATL');
    appointments.add(appointment);
}

List<HvacDemoUtil.Slot> sea = HvacDemoUtil.nextSlots('98052', false, null, 3);
if (!sea.isEmpty()) {
    HvacDemoUtil.Slot slot = sea[0];
    HVAC_Appointment__c appointment = new HVAC_Appointment__c(
        Caller_Name__c = 'Ellis',
        Callback_Phone_Masked__c = 'xxx-xxx-7731',
        Service_Address__c = '15400 Northeast 40th Street, Redmond',
        Postal_Code__c = '98052',
        Property_Type__c = 'Residential',
        Service_Type__c = 'Repair',
        Appointment_Type__c = 'Scheduled',
        Status__c = 'Scheduled',
        Scheduled_Window__c = slot.label,
        Slot_Id__c = slot.slotId,
        Window_Start__c = slot.windowStart,
        Window_End__c = slot.windowEnd,
        Time_Zone__c = slot.timeZoneName,
        Technician_Name__c = 'Sloane Pettigrew'
    );
    HvacDemoUtil.stampDemo(appointment, 'SEED-SESSION-SEA');
    appointments.add(appointment);
}

insert appointments;

for (HVAC_Appointment__c row : [
        SELECT Name, Caller_Name__c, Callback_Phone_Masked__c, Postal_Code__c, Scheduled_Window__c
        FROM HVAC_Appointment__c WHERE Is_Demo_Record__c = true ORDER BY Name]) {
    System.debug('SEEDED ' + row.Name + ' | ' + row.Caller_Name__c + ' | '
        + row.Callback_Phone_Masked__c + ' | ' + row.Postal_Code__c + ' | ' + row.Scheduled_Window__c);
}
System.debug('Technicians: ' + [SELECT COUNT() FROM HVAC_Technician__c]
    + ' Plans: ' + [SELECT COUNT() FROM HVAC_Service_Plan__c]);
