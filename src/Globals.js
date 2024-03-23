// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { WorkItemTrackingRestClient } from 'azure-devops-extension-api/WorkItemTracking';
import { CommonServiceIds } from 'azure-devops-extension-api/Common/CommonServices';


// WorkItemTrackingRestClient: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient
export var gWorkItemRESTClient;

// ILocationService: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/ilocationservice
export var gLocationService;


export async function InitSharedGlobals(adoSDK, adoAPI)
{
    gLocationService = await adoSDK.getService(CommonServiceIds.LocationService);
    
    // getClient(): https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/#azure-devops-extension-api-getclient
    // Gives a WorkItemTrackingRestClient: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/workitemtrackingrestclient
    gWorkItemRESTClient = adoAPI.getClient(WorkItemTrackingRestClient);
}
