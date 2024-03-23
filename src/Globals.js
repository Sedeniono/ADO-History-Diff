// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

// WorkItemTrackingRestClient: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient
export var gWorkItemRESTClient;

// ILocationService: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/ilocationservice
export var gLocationService;

// An enum that holds the known field types. E.g. gFieldTypeEnum.Html === 4.
// It is basically https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/fieldtype,
// except that this documentation is incorrect (it shows the wrong numerical ids). (Apparently, the enum 'FieldType'
// exists several times in the API with different definitions, and the tool that creates the documentation cannot handle it?) 
// The correct one is this:
// https://github.com/microsoft/azure-devops-node-api/blob/fa534aef7d79ab4a30ae2b8823654795b6eed1aa/api/interfaces/WorkItemTrackingInterfaces.ts#L460
export var gFieldTypeEnum;


export async function InitSharedGlobals(adoSDK, adoAPI, adoCommonServices, workItemTracking)
{
    gFieldTypeEnum = workItemTracking.FieldType;
    
    gLocationService = await adoSDK.getService(adoCommonServices.CommonServiceIds.LocationService);
    
    // getClient(): https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/#azure-devops-extension-api-getclient
    // Gives a WorkItemTrackingRestClient: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient
    gWorkItemRESTClient = adoAPI.getClient(workItemTracking.WorkItemTrackingRestClient);
}
