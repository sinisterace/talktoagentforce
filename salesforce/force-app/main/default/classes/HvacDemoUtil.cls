/**
 * Shared helpers for the HVAC Service Voice Agent demo actions.
 *
 * This is NOT an invocable action. It holds the logic that every action class needs:
 * postal-code to time-zone mapping, appointment window math done in the service
 * location's local time, spoken-language formatting, phone masking, input truncation,
 * demo-record stamping, and the per-session write cap that keeps a public demo link
 * from filling the org with records.
 */
public with sharing class HvacDemoUtil {

    public static final Integer MAX_WRITES_PER_SESSION = 3;

    /** One offerable arrival window. */
    public class Slot {
        public String slotId;
        public String label;
        public Datetime windowStart;
        public Datetime windowEnd;
        public String timeZoneName;
    }

    // ---------------------------------------------------------------- service area

    private static final Map<String, String> PREFIX_TO_CLUSTER = new Map<String, String>{
        '850' => 'Phoenix Metro',
        '851' => 'Phoenix Metro',
        '852' => 'Phoenix Metro',
        '853' => 'Phoenix Metro',
        '750' => 'Dallas Fort Worth',
        '751' => 'Dallas Fort Worth',
        '752' => 'Dallas Fort Worth',
        '753' => 'Dallas Fort Worth',
        '300' => 'Atlanta Metro',
        '301' => 'Atlanta Metro',
        '303' => 'Atlanta Metro',
        '980' => 'Seattle Metro',
        '981' => 'Seattle Metro',
        '982' => 'Seattle Metro',
        '984' => 'Seattle Metro'
    };

    private static final Map<String, String> CLUSTER_TO_TZ = new Map<String, String>{
        'Phoenix Metro'     => 'America/Phoenix',
        'Dallas Fort Worth' => 'America/Chicago',
        'Atlanta Metro'     => 'America/New_York',
        'Seattle Metro'     => 'America/Los_Angeles'
    };

    /**
     * Every postal code is served. Anyone trying the demo types the postal code they actually
     * live in, and being told their own address is out of area is a dead end that teaches them
     * nothing about the agent. So an unmapped code falls back to the nearest demo metro by its
     * leading digit, which is roughly how US postal codes run east to west, and the caller gets
     * a technician and windows in a sensible local time zone instead of a refusal.
     */
    /** For a postal code that starts with a letter, so no leading digit places it: M5V, SW1A. */
    private static final String DEFAULT_CLUSTER = 'Dallas Fort Worth';

    private static final Map<String, String> FIRST_DIGIT_TO_CLUSTER = new Map<String, String>{
        '0' => 'Atlanta Metro',
        '1' => 'Atlanta Metro',
        '2' => 'Atlanta Metro',
        '3' => 'Atlanta Metro',
        '4' => 'Atlanta Metro',
        '5' => 'Dallas Fort Worth',
        '6' => 'Dallas Fort Worth',
        '7' => 'Dallas Fort Worth',
        '8' => 'Phoenix Metro',
        '9' => 'Seattle Metro'
    };

    /**
     * Callers read confirmation numbers out loud, so what reaches us is anything from
     * "HVA-00005" to "h v a zero zero zero zero five" transcribed as "HVA00005" or just
     * "5". Everything collapses to the canonical HVA-00005 auto-number format.
     */
    public static String normalizeAppointmentNumber(String raw) {
        if (String.isBlank(raw)) {
            return '';
        }
        String cleaned = raw.toUpperCase().replaceAll('[^A-Z0-9]', '');
        if (cleaned.startsWith('HVA')) {
            cleaned = cleaned.substring(3);
        }
        String digits = digitsOnly(cleaned);
        if (String.isBlank(digits)) {
            return '';
        }
        // Trim any spoken leading zeros before re-padding to the auto-number width.
        Integer value;
        try {
            value = Integer.valueOf(digits);
        } catch (Exception e) {
            return '';
        }
        String padded = String.valueOf(value);
        while (padded.length() < 5) {
            padded = '0' + padded;
        }
        return 'HVA-' + padded;
    }

    /**
     * Keeps letters, because plenty of the world's postal codes have them. Stripping M5V 3L9 down
     * to 539 fails the completeness check and traps the caller in a loop being asked for a postal
     * code they already gave.
     *
     * Five or more digits means US style, so the first five win and anything trailing is dropped
     * (ZIP+4, or a state abbreviation that came along for the ride). Otherwise the alphanumeric
     * form is kept as spoken: M5V3L9, SW1A1AA, or a four digit code like 2000.
     */
    public static String normalizePostal(String postalCode) {
        if (String.isBlank(postalCode)) {
            return '';
        }
        String cleaned = postalCode.toUpperCase().replaceAll('[^A-Z0-9]', '');
        String digits = digitsOnly(cleaned);
        if (digits.length() >= 5) {
            return digits.substring(0, 5);
        }
        if (digits.length() == cleaned.length()) {
            return digits;
        }
        return cleaned.length() > 7 ? cleaned.substring(0, 7) : cleaned;
    }

    /**
     * Enough of a postal code to schedule against. Deliberately not "five digits": a Canadian or
     * British code is not five digits and a four digit code is complete in much of the world. Only
     * a genuine mis-transcription, like two or three stray digits, should make us ask again.
     */
    public static Boolean isCompletePostal(String postalCode) {
        return normalizePostal(postalCode).length() >= 4;
    }

    /**
     * Returns null only when there is nothing usable to schedule against, which keeps the re-ask
     * prompts working for a genuine mis-transcription. Anything complete resolves: an exact demo
     * metro when we have one, then the leading-digit fallback for other US codes, and finally the
     * default cluster for a code we cannot place at all, such as a Canadian or British one.
     */
    public static String clusterFor(String postalCode) {
        String p = normalizePostal(postalCode);
        if (!isCompletePostal(p)) {
            return null;
        }
        if (p.length() >= 3) {
            String exact = PREFIX_TO_CLUSTER.get(p.substring(0, 3));
            if (exact != null) {
                return exact;
            }
        }
        String byDigit = FIRST_DIGIT_TO_CLUSTER.get(p.substring(0, 1));
        return byDigit != null ? byDigit : DEFAULT_CLUSTER;
    }

    /**
     * True for any postal code we could read. The demo metros in PREFIX_TO_CLUSTER are the ones
     * with named technicians and real time zones; everywhere else still gets served through the
     * leading-digit fallback, because turning a prospect away is not a demo.
     */
    public static Boolean inServiceArea(String postalCode) {
        return clusterFor(postalCode) != null;
    }

    /** Time zone of the service address, not of the caller. Falls back to Pacific. */
    public static String timeZoneFor(String postalCode) {
        String cluster = clusterFor(postalCode);
        if (cluster == null) {
            return 'America/Los_Angeles';
        }
        return CLUSTER_TO_TZ.get(cluster);
    }

    // ---------------------------------------------------------------- text handling

    public static String digitsOnly(String value) {
        if (String.isBlank(value)) {
            return '';
        }
        return value.replaceAll('[^0-9]', '');
    }

    /** Stores only the last four digits. Nothing on a public link keeps a full number. */
    public static String maskPhone(String phone) {
        String digits = digitsOnly(phone);
        if (digits.length() < 4) {
            return 'xxx-xxxx';
        }
        return 'xxx-xxx-' + digits.substring(digits.length() - 4);
    }

    public static String lastFour(String phone) {
        String digits = digitsOnly(phone);
        if (digits.length() < 4) {
            return '';
        }
        return digits.substring(digits.length() - 4);
    }

    /**
     * True when the caller's spoken phone number matches the one a record was booked under.
     * Only the last four digits are ever stored, so that is all we can compare -- which is
     * enough to stop confirmation-number guessing without keeping a full number on a
     * public-facing demo.
     */
    public static Boolean phoneMatchesRecord(String maskedOnRecord, String callerLastFour) {
        if (String.isBlank(maskedOnRecord) || String.isBlank(callerLastFour)) {
            return false;
        }
        return digitsOnly(maskedOnRecord).endsWith(callerLastFour);
    }

    public static String truncate(String value, Integer maxLength) {
        if (String.isBlank(value)) {
            return '';
        }
        String trimmed = value.trim();
        return trimmed.length() <= maxLength ? trimmed : trimmed.substring(0, maxLength);
    }

    public static String normalizePropertyType(String propertyType) {
        if (String.isNotBlank(propertyType) && propertyType.toLowerCase().contains('commercial')) {
            return 'Commercial';
        }
        return 'Residential';
    }

    public static String normalizeServiceType(String serviceType) {
        String s = String.isBlank(serviceType) ? '' : serviceType.toLowerCase();
        if (s.contains('tune')) {
            return 'Tune-Up';
        }
        if (s.contains('inspect')) {
            return 'Inspection';
        }
        if (s.contains('repair') || s.contains('fix')) {
            return 'Repair';
        }
        return 'Maintenance';
    }

    // ---------------------------------------------------------------- spoken numbers

    private static final List<String> HOUR_WORDS = new List<String>{
        'twelve', 'one', 'two', 'three', 'four', 'five', 'six',
        'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'
    };

    private static String hourWord(Integer hour24) {
        Integer h = Math.mod(hour24, 12);
        if (h == 0) {
            h = 12;
        }
        return HOUR_WORDS[h];
    }

    private static String partOfDay(Integer hour24) {
        if (hour24 < 12) {
            return 'in the morning';
        }
        if (hour24 < 17) {
            return 'in the afternoon';
        }
        return 'in the evening';
    }

    /**
     * The closing hour of a window belongs to the part of day it closes, not the one it
     * opens: a window ending at five is "to five in the afternoon", not "in the evening".
     */
    private static String partOfDayForEnd(Integer hour24) {
        if (hour24 <= 12) {
            return 'in the morning';
        }
        if (hour24 <= 17) {
            return 'in the afternoon';
        }
        return 'in the evening';
    }

    // ---------------------------------------------------------------- window math

    private static Integer tzOffsetMillis(String timeZoneName, Datetime reference) {
        return TimeZone.getTimeZone(timeZoneName).getOffset(reference);
    }

    /**
     * Builds the GMT instant for a wall-clock hour on a local calendar date in the
     * service location's time zone. Datetime.newInstance interprets wall time in the
     * running user's zone, so we shift by the difference between the two offsets.
     */
    private static Datetime localWallClock(Date localDate, Integer hour24, String timeZoneName) {
        Datetime asRunningUser = Datetime.newInstance(localDate, Time.newInstance(hour24, 0, 0, 0));
        Integer userOffset = UserInfo.getTimeZone().getOffset(asRunningUser);
        Integer targetOffset = tzOffsetMillis(timeZoneName, asRunningUser);
        return Datetime.newInstance(asRunningUser.getTime() + userOffset - targetOffset);
    }

    /** Today's calendar date at the service address, which may not be today for the caller. */
    public static Date localToday(String timeZoneName) {
        return Date.valueOf(Datetime.now().format('yyyy-MM-dd', timeZoneName));
    }

    private static String localWeekday(Datetime instant, String timeZoneName) {
        return instant.format('EEEE', timeZoneName);
    }

    /**
     * Spoken description of a window, always in the service location's local time and
     * never as a timestamp. "tomorrow between eight and eleven in the morning".
     */
    public static String describeWindow(Datetime windowStart, Datetime windowEnd, String timeZoneName) {
        if (windowStart == null || windowEnd == null) {
            return '';
        }
        Date today = localToday(timeZoneName);
        Date windowDate = Date.valueOf(windowStart.format('yyyy-MM-dd', timeZoneName));
        String dayPhrase;
        if (windowDate == today) {
            dayPhrase = 'today';
        } else if (windowDate == today.addDays(1)) {
            dayPhrase = 'tomorrow';
        } else if (windowDate < today.addDays(7)) {
            dayPhrase = 'on ' + localWeekday(windowStart, timeZoneName);
        } else {
            dayPhrase = 'on ' + localWeekday(windowStart, timeZoneName) + ' the '
                + windowStart.format('d', timeZoneName);
        }
        Integer startHour = Integer.valueOf(windowStart.format('H', timeZoneName));
        Integer endHour = Integer.valueOf(windowEnd.format('H', timeZoneName));
        // A window that crosses noon or dinnertime needs the part of day on both ends,
        // otherwise "between eleven and two in the morning" comes out of the speaker.
        String endPart = partOfDayForEnd(endHour);
        if (partOfDay(startHour) != endPart) {
            return dayPhrase + ' between ' + hourWord(startHour) + ' ' + partOfDay(startHour)
                + ' and ' + hourWord(endHour) + ' ' + endPart;
        }
        return dayPhrase + ' between ' + hourWord(startHour) + ' and ' + hourWord(endHour)
            + ' ' + endPart;
    }

    /** Standard published arrival windows, as local start hour to local end hour. */
    private static List<List<Integer>> windowsForDay(String weekday, Boolean commercial) {
        List<List<Integer>> windows = new List<List<Integer>>();
        if (weekday == 'Sunday') {
            return windows;
        }
        if (weekday == 'Saturday') {
            // Saturday is 8 AM to 4 PM, scheduled maintenance only.
            windows.add(new List<Integer>{ 8, 11 });
            windows.add(new List<Integer>{ 11, 14 });
            return windows;
        }
        if (commercial) {
            // Commercial maintenance defaults to the morning window.
            windows.add(new List<Integer>{ 8, 11 });
            windows.add(new List<Integer>{ 11, 14 });
            return windows;
        }
        windows.add(new List<Integer>{ 8, 11 });
        windows.add(new List<Integer>{ 11, 14 });
        windows.add(new List<Integer>{ 14, 17 });
        windows.add(new List<Integer>{ 17, 19 });
        return windows;
    }

    private static Integer preferenceScore(String preferredTimeframe, Datetime windowStart, String timeZoneName) {
        if (String.isBlank(preferredTimeframe)) {
            return 0;
        }
        String p = preferredTimeframe.toLowerCase();
        Integer startHour = Integer.valueOf(windowStart.format('H', timeZoneName));
        String weekday = localWeekday(windowStart, timeZoneName).toLowerCase();
        Integer score = 0;
        if (p.contains('morning') && startHour < 12) {
            score += 3;
        }
        if (p.contains('afternoon') && startHour >= 11 && startHour < 17) {
            score += 3;
        }
        if (p.contains('evening') && startHour >= 17) {
            score += 3;
        }
        if (p.contains(weekday)) {
            score += 4;
        }
        if (p.contains('asap') || p.contains('soon') || p.contains('today')) {
            score += 1;
        }
        return score;
    }

    /**
     * The next offerable windows for a service location, computed from the current
     * moment in that location's time zone. Windows already booked by a demo session
     * are excluded, and nothing inside the two-hour change cutoff is offered.
     */
    public static List<Slot> nextSlots(String postalCode, Boolean commercial, String preferredTimeframe, Integer howMany) {
        String tz = timeZoneFor(postalCode);
        Datetime cutoff = Datetime.now().addHours(2);
        Date startDate = localToday(tz);
        if (String.isNotBlank(preferredTimeframe) && preferredTimeframe.toLowerCase().contains('next week')) {
            startDate = startDate.addDays(7);
        }

        List<Slot> candidates = new List<Slot>();
        for (Integer dayOffset = 0; dayOffset < 14 && candidates.size() < 20; dayOffset++) {
            Date localDate = startDate.addDays(dayOffset);
            Datetime probe = localWallClock(localDate, 12, tz);
            for (List<Integer> window : windowsForDay(localWeekday(probe, tz), commercial)) {
                Datetime windowStart = localWallClock(localDate, window[0], tz);
                Datetime windowEnd = localWallClock(localDate, window[1], tz);
                if (windowStart < cutoff) {
                    continue;
                }
                Slot slot = new Slot();
                slot.windowStart = windowStart;
                slot.windowEnd = windowEnd;
                slot.timeZoneName = tz;
                slot.slotId = 'SLOT-' + String.valueOf(windowStart.getTime()) + '-' + String.valueOf(window[1] - window[0]);
                slot.label = describeWindow(windowStart, windowEnd, tz);
                candidates.add(slot);
            }
        }

        Set<String> taken = new Set<String>();
        Set<String> candidateIds = new Set<String>();
        for (Slot slot : candidates) {
            candidateIds.add(slot.slotId);
        }
        if (!candidateIds.isEmpty()) {
            for (HVAC_Appointment__c existing : [
                SELECT Slot_Id__c FROM HVAC_Appointment__c
                WHERE Slot_Id__c IN :candidateIds AND Status__c = 'Scheduled'
                LIMIT 200
            ]) {
                taken.add(existing.Slot_Id__c);
            }
        }

        List<Slot> available = new List<Slot>();
        for (Slot slot : candidates) {
            if (!taken.contains(slot.slotId)) {
                available.add(slot);
            }
        }

        // Preferred windows first, otherwise soonest first. Stable and simple: pull out
        // anything that scores, then top up from the front of the remaining list.
        List<Slot> preferred = new List<Slot>();
        List<Slot> rest = new List<Slot>();
        for (Slot slot : available) {
            if (preferenceScore(preferredTimeframe, slot.windowStart, tz) > 0) {
                preferred.add(slot);
            } else {
                rest.add(slot);
            }
        }
        List<Slot> chosen = new List<Slot>();
        for (Slot slot : preferred) {
            if (chosen.size() < howMany) {
                chosen.add(slot);
            }
        }
        for (Slot slot : rest) {
            if (chosen.size() < howMany) {
                chosen.add(slot);
            }
        }
        return chosen;
    }

    /** Rebuilds a window from a slot token so booking never trusts a spoken time. */
    public static Slot slotFromId(String slotId, String postalCode) {
        if (String.isBlank(slotId) || !slotId.startsWith('SLOT-')) {
            return null;
        }
        List<String> parts = slotId.split('-');
        if (parts.size() != 3) {
            return null;
        }
        try {
            Long startMillis = Long.valueOf(parts[1]);
            Integer lengthHours = Integer.valueOf(parts[2]);
            Slot slot = new Slot();
            slot.slotId = slotId;
            slot.timeZoneName = timeZoneFor(postalCode);
            slot.windowStart = Datetime.newInstance(startMillis);
            slot.windowEnd = slot.windowStart.addHours(lengthHours);
            slot.label = describeWindow(slot.windowStart, slot.windowEnd, slot.timeZoneName);
            return slot;
        } catch (Exception e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- emergency window

    public static Boolean isAfterHours(String postalCode) {
        String tz = timeZoneFor(postalCode);
        Datetime now = Datetime.now();
        String weekday = localWeekday(now, tz);
        Integer hour = Integer.valueOf(now.format('H', tz));
        if (weekday == 'Sunday') {
            return true;
        }
        if (weekday == 'Saturday') {
            return hour < 8 || hour >= 16;
        }
        return hour < 7 || hour >= 19;
    }

    /** Emergency arrival window: earliest available hours from now, plus a two-hour band. */
    public static Slot emergencyWindow(String postalCode, Decimal earliestInHours) {
        String tz = timeZoneFor(postalCode);
        Integer lead = earliestInHours == null ? 2 : Integer.valueOf(earliestInHours);
        if (lead < 1) {
            lead = 1;
        }
        Slot slot = new Slot();
        slot.timeZoneName = tz;
        slot.windowStart = Datetime.now().addHours(lead);
        slot.windowEnd = slot.windowStart.addHours(2);
        slot.slotId = 'EMERGENCY-' + String.valueOf(slot.windowStart.getTime());
        slot.label = describeWindow(slot.windowStart, slot.windowEnd, tz);
        return slot;
    }

    // ---------------------------------------------------------------- appointment access

    /**
     * The outcome of trying to reach one caller's appointment. Either `appointment` is
     * populated, or `refusal` holds the sentence the agent should speak. Never both.
     */
    public class AppointmentAccess {
        public HVAC_Appointment__c appointment;
        public String refusal;
        public Boolean granted {
            get {
                return appointment != null;
            }
        }
    }

    /**
     * Resolves a spoken confirmation number plus the phone the visit was booked under to
     * one demo appointment, or to the sentence explaining why not.
     *
     * Ownership check. Confirmation numbers are sequential and spoken aloud, so knowing one
     * is not proof of ownership -- anyone on a public link could walk HVA-00001..N and cancel
     * other callers' visits. The caller must also produce the phone the visit was booked
     * under. Enforced here, not only in the agent script, so no amount of talking the planner
     * out of a step can reach the DML. Lives in one place because all three change actions
     * -- cancel, offer other windows, apply a new window -- have to clear the same bar.
     */
    public static AppointmentAccess resolveAppointment(String appointmentNumber, String callbackPhone) {
        AppointmentAccess access = new AppointmentAccess();

        String appointmentKey = normalizeAppointmentNumber(appointmentNumber);
        if (String.isBlank(appointmentKey)) {
            access.refusal = 'I need the appointment confirmation number before I can change anything.';
            return access;
        }

        String callerLastFour = lastFour(callbackPhone);
        if (String.isBlank(callerLastFour)) {
            access.refusal = 'Before I change that visit I need the phone number it was booked under.';
            return access;
        }

        List<HVAC_Appointment__c> matches = [
            SELECT Id, Name, Postal_Code__c, Service_Type__c, Status__c, Scheduled_Window__c,
                   Window_Start__c, Window_End__c, Slot_Id__c, Time_Zone__c, Callback_Phone_Masked__c
            FROM HVAC_Appointment__c
            WHERE Name = :appointmentKey AND Is_Demo_Record__c = true
            LIMIT 1
        ];
        if (matches.isEmpty()) {
            access.refusal = 'I could not find an appointment with that confirmation number.';
            return access;
        }

        if (!phoneMatchesRecord(matches[0].Callback_Phone_Masked__c, callerLastFour)) {
            // Deliberately the same wording as a miss on the number, so a caller probing
            // numbers learns nothing about which ones exist.
            access.refusal = 'That confirmation number and phone number do not match an appointment I can change. '
                + 'Let me check them with you again.';
            return access;
        }

        access.appointment = matches[0];
        return access;
    }

    /**
     * The published two-hour rule, worded for speech. Both the cancel and the reschedule
     * paths quote it, so it is written once.
     */
    public static String tripChargeSentence(HVAC_Appointment__c appointment) {
        Boolean insideCutoff = appointment.Window_Start__c != null
            && appointment.Window_Start__c < Datetime.now().addHours(2);
        return insideCutoff
            ? ' Because this is inside two hours of the window, a fifty nine dollar trip charge applies.'
            : ' There is no charge for this change.';
    }

    // ---------------------------------------------------------------- demo guardrails

    public static void stampDemo(HVAC_Appointment__c record, String sessionId) {
        record.Is_Demo_Record__c = true;
        record.Demo_Session_Id__c = truncate(sessionId, 255);
    }

    /**
     * A public demo link means anyone can hammer these write actions. Three records per
     * messaging session is enough to show every flow and not enough to be a problem.
     */
    public static Boolean sessionCapReached(String sessionId) {
        if (String.isBlank(sessionId)) {
            return false;
        }
        String key = truncate(sessionId, 255);
        // Appointments are the only thing this agent writes. There is no callback or
        // follow-up path, so nothing else needs counting here.
        Integer appointments = [
            SELECT COUNT() FROM HVAC_Appointment__c
            WHERE Demo_Session_Id__c = :key AND Is_Demo_Record__c = true
        ];
        return appointments >= MAX_WRITES_PER_SESSION;
    }
}
