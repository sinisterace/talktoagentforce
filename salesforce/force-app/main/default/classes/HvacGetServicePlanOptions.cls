/**
 * Explains a service plan tier from the published catalog. This never reads a customer
 * contract, because a caller on a public link is not verified — the honest framing is
 * "here is what that plan includes", not "here is what you have".
 */
public with sharing class HvacGetServicePlanOptions {

    public class Request {
        @InvocableVariable(label='currentPlanName' description='The plan the caller says they are on, if any.')
        public String currentPlanName;

        @InvocableVariable(label='propertyType' description='residential or commercial.')
        public String propertyType;
    }

    public class Response {
        @InvocableVariable(label='currentPlanSummary' description='What that tier includes.')
        public String currentPlanSummary;

        @InvocableVariable(label='renewalSummary' description='Renewal terms and price.')
        public String renewalSummary;

        @InvocableVariable(label='upgradeSummary' description='What the recommended next tier adds.')
        public String upgradeSummary;

        @InvocableVariable(label='upgradePlanName' description='Name of the recommended next tier.')
        public String upgradePlanName;

        @InvocableVariable(label='planFound' description='True when the named plan matched the catalog.')
        public Boolean planFound;
    }

    @InvocableMethod(
        label='Get Service Plan Options'
        description='Returns what a service plan tier includes, its renewal terms and price, and the recommended next tier.'
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
        response.currentPlanSummary = '';
        response.renewalSummary = '';
        response.upgradeSummary = '';
        response.upgradePlanName = '';
        response.planFound = false;

        String propertyType = HvacDemoUtil.normalizePropertyType(request.propertyType);

        List<HVAC_Service_Plan__c> plans = [
            SELECT Name, Annual_Price__c, Price_Unit__c, Property_Type__c, Tier_Rank__c,
                   Inclusions__c, Renewal_Terms__c, Diagnostic_Fee_Text__c, Next_Tier_Plan_Name__c
            FROM HVAC_Service_Plan__c
            WHERE Property_Type__c = :propertyType
            ORDER BY Tier_Rank__c ASC
            LIMIT 20
        ];
        if (plans.isEmpty()) {
            response.currentPlanSummary = 'I do not have the plan catalog available right now.';
            return response;
        }

        HVAC_Service_Plan__c current = matchPlan(plans, request.currentPlanName);
        if (current == null) {
            // No plan named, or an unrecognized one: describe the entry tier honestly.
            current = plans[0];
        } else {
            response.planFound = true;
        }

        response.currentPlanSummary = current.Name + ' is ' + spokenPrice(current) + '. '
            + blankSafe(current.Inclusions__c);
        response.renewalSummary = blankSafe(current.Renewal_Terms__c) + ' '
            + blankSafe(current.Diagnostic_Fee_Text__c);

        HVAC_Service_Plan__c upgrade = null;
        if (String.isNotBlank(current.Next_Tier_Plan_Name__c)) {
            upgrade = matchPlan(plans, current.Next_Tier_Plan_Name__c);
        }
        if (upgrade == null) {
            for (HVAC_Service_Plan__c plan : plans) {
                if (plan.Tier_Rank__c != null && current.Tier_Rank__c != null
                        && plan.Tier_Rank__c > current.Tier_Rank__c) {
                    upgrade = plan;
                    break;
                }
            }
        }

        if (upgrade == null) {
            response.upgradeSummary = current.Name + ' is already our top tier, so there is nothing above it to move up to.';
            return response;
        }

        response.upgradePlanName = upgrade.Name;
        response.upgradeSummary = 'Moving up to ' + upgrade.Name + ' is ' + spokenPrice(upgrade) + '. '
            + blankSafe(upgrade.Inclusions__c);
        return response;
    }

    private static HVAC_Service_Plan__c matchPlan(List<HVAC_Service_Plan__c> plans, String name) {
        if (String.isBlank(name)) {
            return null;
        }
        String needle = name.trim().toLowerCase();
        for (HVAC_Service_Plan__c plan : plans) {
            if (plan.Name.toLowerCase() == needle) {
                return plan;
            }
        }
        for (HVAC_Service_Plan__c plan : plans) {
            String planName = plan.Name.toLowerCase();
            if (planName.contains(needle) || needle.contains(planName)) {
                return plan;
            }
        }
        return null;
    }

    private static String spokenPrice(HVAC_Service_Plan__c plan) {
        if (plan.Annual_Price__c == null) {
            return 'quoted per site';
        }
        String amount = String.valueOf(plan.Annual_Price__c.setScale(0));
        String unit = String.isBlank(plan.Price_Unit__c) ? 'a year' : plan.Price_Unit__c;
        return amount + ' dollars ' + unit;
    }

    private static String blankSafe(String value) {
        return String.isBlank(value) ? '' : value.trim();
    }
}
