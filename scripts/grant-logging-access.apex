// Grants the transcript-logging connected app everything it needs to write
// Demo_Session__c and Demo_Turn__c. Idempotent — safe to re-run after adding a
// field to either object.
//
//   sf apex run -o talktoAgentforceSDO -f scripts/grant-logging-access.apex
//
// Three separate things have to be true before the client-credentials flow can
// insert a record, and each fails with a different, misleading error:
//
//   1. Enable Client Credentials Flow + Run As on the connected app  (UI only)
//        missing -> "no client credentials user enabled"
//   2. The Run As user has a permission set granting the connected app
//        missing -> "user is not admin approved to access this app"
//   3. That permission set grants object + field access
//        missing -> "No such column 'Conversation_Id__c'" — which reads like a
//                   failed deploy, but the fields are there and invisible.
//
// Step 1 is manual. Steps 2 and 3 are this script, except for the
// SetupEntityAccess row in step 2, which Apex cannot insert — see below.

final String PERMSET = 'Voice_Demo_Logger_Access';
// Defaults to whoever runs the script; set an explicit username to grant someone else.
final String RUN_AS_USER = UserInfo.getUserName();
final String APP_NAME = 'Voice Demo Logger';

Map<String, List<String>> fieldsByObject = new Map<String, List<String>>{
    'Demo_Session__c' => new List<String>{
        'Agent_Template__c', 'Conversation_Id__c', 'Started_At__c'
    },
    'Demo_Turn__c' => new List<String>{
        // Demo_Session__c is the master-detail field and is deliberately absent:
        // FieldPermissions rejects required fields, which master-detail always is.
        'Speaker__c', 'Turn_Number__c', 'Transcript__c', 'Spoken_At__c', 'Latency_Ms__c'
    }
};

// --- permission set ---------------------------------------------------------
PermissionSet ps;
List<PermissionSet> found = [SELECT Id FROM PermissionSet WHERE Name = :PERMSET LIMIT 1];
if (found.isEmpty()) {
    ps = new PermissionSet(
        Name = PERMSET,
        Label = 'Voice Demo Logger Access',
        Description = 'Grants the client-credentials Run As user access to the ' +
                      APP_NAME + ' connected app and the demo transcript objects.'
    );
    insert ps;
    System.debug('created permission set ' + ps.Id);
} else {
    ps = found[0];
    System.debug('reusing permission set ' + ps.Id);
}

// --- assignment -------------------------------------------------------------
Id userId = [SELECT Id FROM User WHERE Username = :RUN_AS_USER LIMIT 1].Id;
if ([SELECT COUNT() FROM PermissionSetAssignment
     WHERE PermissionSetId = :ps.Id AND AssigneeId = :userId] == 0) {
    insert new PermissionSetAssignment(PermissionSetId = ps.Id, AssigneeId = userId);
    System.debug('assigned to ' + RUN_AS_USER);
}

// --- object permissions -----------------------------------------------------
// ObjectPermissions and FieldPermissions have no external id, so upsert() would
// try to insert duplicates on a second run. Query what exists and insert only
// the gap, which is what makes this script safe to re-run.
Set<String> haveObjects = new Set<String>();
for (ObjectPermissions op : [SELECT SobjectType FROM ObjectPermissions WHERE ParentId = :ps.Id]) {
    haveObjects.add(op.SobjectType);
}
List<ObjectPermissions> newObjPerms = new List<ObjectPermissions>();
for (String obj : fieldsByObject.keySet()) {
    if (haveObjects.contains(obj)) continue;
    newObjPerms.add(new ObjectPermissions(
        ParentId = ps.Id, SobjectType = obj,
        PermissionsRead = true, PermissionsCreate = true, PermissionsEdit = true,
        PermissionsViewAllRecords = true
    ));
}
if (!newObjPerms.isEmpty()) {
    for (Database.SaveResult r : Database.insert(newObjPerms, false)) {
        if (!r.isSuccess()) System.debug('object permission failed: ' + r.getErrors());
    }
}
System.debug('object permissions: ' + newObjPerms.size() + ' added, ' +
             haveObjects.size() + ' already present');

// --- field permissions ------------------------------------------------------
Set<String> haveFields = new Set<String>();
for (FieldPermissions fp : [SELECT Field FROM FieldPermissions WHERE ParentId = :ps.Id]) {
    haveFields.add(fp.Field);
}
List<FieldPermissions> newFps = new List<FieldPermissions>();
for (String obj : fieldsByObject.keySet()) {
    for (String f : fieldsByObject.get(obj)) {
        String api = obj + '.' + f;
        if (haveFields.contains(api)) continue;
        newFps.add(new FieldPermissions(
            ParentId = ps.Id, SobjectType = obj, Field = api,
            PermissionsRead = true, PermissionsEdit = true
        ));
    }
}
Integer granted = 0;
if (!newFps.isEmpty()) {
    for (Database.SaveResult r : Database.insert(newFps, false)) {
        if (r.isSuccess()) { granted++; } else { System.debug('field failed: ' + r.getErrors()); }
    }
}
System.debug('field permissions: ' + granted + ' added, ' +
             (newFps.size() - granted) + ' failed, ' + haveFields.size() + ' already present');

// --- connected app grant ----------------------------------------------------
// SetupEntityAccess is not insertable from Apex. It has to go through the REST
// API, and note that SetupEntityType must be OMITTED from the payload — it is
// derived from SetupEntityId, and sending it returns INVALID_FIELD_FOR_INSERT_UPDATE.
Id appId = [SELECT Id FROM ConnectedApplication WHERE Name = :APP_NAME LIMIT 1].Id;
if ([SELECT COUNT() FROM SetupEntityAccess
     WHERE ParentId = :ps.Id AND SetupEntityId = :appId] == 0) {
    System.debug('STILL NEEDED — run this shell command:');
    System.debug('TOK=$(sf org auth show-access-token -o talktoAgentforceSDO --json | python3 -c "import json,sys;s=sys.stdin.read();print(json.loads(s[s.index(chr(123)):])[\'result\'][\'accessToken\'])")');
    System.debug('curl -X POST "$SF_INSTANCE_URL/services/data/v64.0/sobjects/SetupEntityAccess" \\');
    System.debug('  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \\');
    System.debug('  --data \'{"ParentId":"' + ps.Id + '","SetupEntityId":"' + appId + '"}\'');
} else {
    System.debug('connected app already granted to the permission set');
}
