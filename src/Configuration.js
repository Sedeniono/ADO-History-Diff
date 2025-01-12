// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { CommonServiceIds } from 'azure-devops-extension-api/Common/CommonServices';

const FIELD_FILTER_CONFIG = "FieldFilterTest";

// IExtensionDataManager: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iextensiondatamanager
var gExtensionDataManager;

var gFieldFilter;


export async function LoadConfiguration(adoSDK)
{
    const extensionContext = adoSDK.getExtensionContext()
    
    const [accessToken, extensionDataService] = await Promise.all([
        adoSDK.getAccessToken(),
        adoSDK.getService(CommonServiceIds.ExtensionDataService)
    ]);
    
    // https://learn.microsoft.com/en-us/azure/devops/extend/develop/data-storage?view=azure-devops-2020
    gExtensionDataManager = await extensionDataService.getExtensionDataManager(extensionContext.id, accessToken);
    gFieldFilter = await gExtensionDataManager.getValue(FIELD_FILTER_CONFIG, {scopeType: "User", defaultValue: ""});
}


export async function SaveFieldFilterToConfig(newFieldFilter)
{
    gFieldFilter = newFieldFilter;
    gExtensionDataManager.setValue(FIELD_FILTER_CONFIG, newFieldFilter, {scopeType: "User"})
}


export function GetFieldFilterConfig()
{
    return gFieldFilter;
}
