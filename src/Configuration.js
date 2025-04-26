// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check

import { CommonServiceIds } from 'azure-devops-extension-api/Common/CommonServices';
import { StringsMatchCaseInsensitiveWithWildcard, GetHtmlElement } from './Utils.js';

// @ts-ignore (webpack magic)
import CollapseSvg from '../images/divider-collapse-horizontal-icon.svg';
// @ts-ignore (webpack magic)
import ExpandSvg from '../images/divider-split-horizontal-icon.svg';
// @ts-ignore (webpack magic)
import SettingsSvg from '../images/setting-icon.svg';


const USER_CONFIG_KEY = 'HistoryDiffUserConfig';

// IExtensionDataManager: https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/iextensiondatamanager
var gExtensionDataManager;


// The current version the extension uses. Every time we need to break backwards compatibility, we will
// increment it. That way we know when we read configs from an older version of the extension.
const USER_CONFIG_VERSION = 4;


/**
 * UserConfig constructor
 * @param {string[]} fieldFilters
 * @param {boolean} fieldFiltersDisabled
 * @param {boolean} showUnchangedLines
 * @param {number} numContextLines
 * @param {boolean} limitMaxTileWidth
 * @param {number} maxTileWidth
 */
function UserConfig(
    fieldFilters, 
    fieldFiltersDisabled, 
    showUnchangedLines, 
    numContextLines, 
    limitMaxTileWidth, 
    maxTileWidth)
{
    /** 
     * We store some version in the config so that we can better deal with future changes to the extension
     * that might make it necessary to brake backwards compatibility.
     * @type {Number} 
     */
    this.configVersion = USER_CONFIG_VERSION;
    
    /** 
     * If an element matches a row name (i.e. field name), that corresponding field is omitted from the history.
     * The intention is so that the user can hide uninteresting fields such as working logging related fields.
     * @type {string[]} 
     */
    this.fieldFilters = fieldFilters;

    /** 
     * If true, the filters are disabled. The intention is that the user can temporarily disable
     * the filters without having to remove then (and then re-add them later).
     * @type {boolean} 
     */
    this.fieldFiltersDisabled = fieldFiltersDisabled;

    /** 
     * If true, all lines are shown. If false, only a context window around an <ins> and <del> element is shown,
     * i.e. N lines below and above (where N = numContextLines).
     * @type {boolean} 
     */
    this.showUnchangedLines = showUnchangedLines;

    /** 
     * An integer >= 0. Specifies the number of lines below and above each <ins> and <del> element to show.
     * Only relevant if `showUnchangedLines` is true.
     * @type {Number} 
     */
    this.numContextLines = numContextLines;

    /** 
     * If true, tiles are limited to a max. width of `limitMaxTileWidth`.
     * Having very wide tiles can make the text hard to read for ultra-wide screens because the text lines are so wide.
     * So the user might want to limit the max. width.
     * @type {boolean} 
     */
    this.limitMaxTileWidth = limitMaxTileWidth;
    
    /** 
     * An integer >= 1. Specifies the max. width of the tiles.
     * Only relevant if `limitMaxTileWidth` is true.
     * @type {Number} 
     */
    this.maxTileWidth = maxTileWidth;
}


// Notes:
// - fieldFilters: In earlier version of the HistoryDiff extension, we hid the "Rev" (=revision) and stack rank fields 
//   from users always. They clutter up the history quite a lot, and are probably uninteresting for many users. Hence
//   we want to hide them by default. (We show these fields at all due to GitHub issues #2 and #3.)
// - maxTileWidth: The value was found by considering typical screen widths of 1680px and 1920px at various zoom levels
//   and with the ADO side bar collapsed and expanded, and considering where the config buttons end up being placed. 
//   The value was found to be reasonable in most cases.
const DEFAULT_USER_CONFIG = new UserConfig(['Rev', 'Stack Rank'], false, false, 3, true, 1020);

var gUserConfig = DEFAULT_USER_CONFIG;

var gInitConfigurationPromise;


export function InitializeConfiguration(adoSDK, configChangedCallback, toggleContextCallback)
{
    // To improve loading times, we want to simultaneously fetch the configuration and the item's history.
    // Therefore, we do not "await" the promise here, but instead only once we really need to access the
    // config data.
    gInitConfigurationPromise = LoadAndInitializeConfiguration(adoSDK, configChangedCallback, toggleContextCallback);
}


export async function IsFieldShownByUserConfig(rowName)
{
    await gInitConfigurationPromise;
    return IsFieldShownByUserConfigImpl(rowName);
}


function IsFieldShownByUserConfigImpl(rowName)
{
    if (!AnyFieldFiltersEnabled()) {
        return true;
    }
    return !gUserConfig.fieldFilters.some(filteredField => StringsMatchCaseInsensitiveWithWildcard(rowName, filteredField));
}


export async function UpdateConfigDialogFieldSuggestions(fields)
{
    await gInitConfigurationPromise;

    const datalist = GetHtmlElement('config-dialog-suggested-fields');
    datalist.replaceChildren();
    for (const field of fields) {
        if (IsFieldShownByUserConfigImpl(field)) { // Don't suggest already hidden fields.
            const newOption = document.createElement('option');
            newOption.value = field;
            datalist.appendChild(newOption);
        }
    }
}


export async function GetUserConfig()
{
    await gInitConfigurationPromise;
    return gUserConfig;
}


async function LoadAndInitializeConfiguration(adoSDK, configChangedCallback, toggleContextCallback)
{
    await LoadConfiguration(adoSDK);
    InitializeConfigDialog(configChangedCallback, toggleContextCallback);
}


async function LoadConfiguration(adoSDK)
{
    try {
        const extensionContext = adoSDK.getExtensionContext()
        
        const [accessToken, extensionDataService] = await Promise.all([
            adoSDK.getAccessToken(),
            adoSDK.getService(CommonServiceIds.ExtensionDataService)
        ]);
        
        // https://learn.microsoft.com/en-us/azure/devops/extend/develop/data-storage?view=azure-devops-2020
        // The data is stored on the server per user.
        gExtensionDataManager = await extensionDataService.getExtensionDataManager(extensionContext.id, accessToken);
        gUserConfig = await gExtensionDataManager.getValue(USER_CONFIG_KEY, {scopeType: 'User', defaultValue: DEFAULT_USER_CONFIG});
        if (!gUserConfig) {
            gUserConfig = DEFAULT_USER_CONFIG;
        }
        else if (gUserConfig.configVersion <= 1) {
            // For configs from earlier versions of the extension, add the "Rev" and stack rank fields, since we now
            // no longer hide these fields always. Also compare explanation at DEFAULT_USER_CONFIG.
            if (!gUserConfig.fieldFilters) {
                gUserConfig.fieldFilters = []
            }
            if (gUserConfig.fieldFilters.indexOf('Rev') < 0) {
                gUserConfig.fieldFilters.push('Rev');
            }
            if (gUserConfig.fieldFilters.indexOf('Stack Rank') < 0) {
                gUserConfig.fieldFilters.push('Stack Rank');
            }
        }
        else if (gUserConfig.configVersion <= 2) {
            gUserConfig.showUnchangedLines = DEFAULT_USER_CONFIG.showUnchangedLines;
            gUserConfig.numContextLines = DEFAULT_USER_CONFIG.numContextLines;
        }
        else if (gUserConfig.configVersion <= 3) {
            gUserConfig.limitMaxTileWidth = DEFAULT_USER_CONFIG.limitMaxTileWidth;
            gUserConfig.maxTileWidth = DEFAULT_USER_CONFIG.maxTileWidth;
        }

        gUserConfig.numContextLines = SanitizeNumberOfContextLinesInput(gUserConfig.numContextLines);
        gUserConfig.maxTileWidth = SanitizeMaxTileWidthInput(gUserConfig.maxTileWidth);
        gUserConfig.configVersion = USER_CONFIG_VERSION;
    }
    catch (ex) {
        console.log(`HistoryDiff: Exception trying to load configuration: ${ex}`);
    }
}


function SaveNewUserConfig(userConfig)
{
    try {
        gUserConfig = userConfig;
        gUserConfig.numContextLines = SanitizeNumberOfContextLinesInput(gUserConfig.numContextLines);
        gUserConfig.maxTileWidth = SanitizeMaxTileWidthInput(gUserConfig.maxTileWidth);
        gExtensionDataManager.setValue(USER_CONFIG_KEY, gUserConfig, {scopeType: 'User'});
    }
    catch (ex) {
        console.log(`HistoryDiff: Exception trying to save configuration: ${ex}`);
    }
}


function AnyFieldFiltersEnabled()
{
    return gUserConfig && !gUserConfig.fieldFiltersDisabled && gUserConfig.fieldFilters && gUserConfig.fieldFilters.length >= 0;
}


export function GetConfigDialog()
{
    return GetHtmlElement('config-dialog');
}

function GetOpenConfigButton()
{
    return GetHtmlElement('config-dialog-show');
}

function GetToggleContextButton()
{
    return GetHtmlElement('toggle-context');
}

function GetDisabledAllFieldFiltersCheckbox()
{
    return GetHtmlElement('config-dialog-disable-all-field-filters');
}

function GetShowUnchangedLinesCheckbox()
{
    return GetHtmlElement('config-dialog-show-unchanged-lines');
}

function GetNumContextLinesControl()
{
    return GetHtmlElement('config-dialog-num-context-lines');
}

function GetLimitMaxTileWidthCheckbox()
{
    return GetHtmlElement('config-dialog-limit-tile-width');
}

function GetMaxTileWidthControl()
{
    return GetHtmlElement('config-dialog-max-tile-width');
}


function UpdateOpenConfigButtonWithNumFilters()
{
    const img = document.createElement('img');
    img.classList.add('img-in-button');
    img.classList.add('img-invert-for-dark-mode');
    img.src = SettingsSvg;
    img.style.marginRight = '5px';
        
    const numFilters = AnyFieldFiltersEnabled() ? gUserConfig.fieldFilters.length : 0;
    const textNode = document.createTextNode(
        numFilters === 1 ? `(${numFilters} filter)` : `(${numFilters} filters)`);

    const openConfigButton = GetOpenConfigButton();
    openConfigButton.textContent = '';
    openConfigButton.append(img, textNode);
}


function InitializeConfigDialog(configChangedCallback, toggleContextCallback)
{
    UpdateOpenConfigButtonWithNumFilters();
    InitializeToggleContextButton(toggleContextCallback);

    const configDialog = GetConfigDialog();
    const fieldFiltersTable = GetHtmlElement('config-dialog-field-filters-table');
    const disabledFieldFiltersCheckbox = GetDisabledAllFieldFiltersCheckbox();
    
    GetOpenConfigButton().addEventListener(
        'click', 
        () => {
            SetCurrentFieldFiltersInDialog(fieldFiltersTable);
            // @ts-ignore
            disabledFieldFiltersCheckbox.checked = gUserConfig?.fieldFiltersDisabled;
            // @ts-ignore
            GetShowUnchangedLinesCheckbox().checked = gUserConfig?.showUnchangedLines;
            // @ts-ignore
            GetNumContextLinesControl().value = gUserConfig?.numContextLines;
            // @ts-ignore
            GetLimitMaxTileWidthCheckbox().checked = gUserConfig?.limitMaxTileWidth;
            // @ts-ignore
            GetMaxTileWidthControl().value = gUserConfig?.maxTileWidth;
            // @ts-ignore
            configDialog.showModal();
    });

    GetHtmlElement('config-dialog-ok').addEventListener(
        'click', 
        () => {
            SaveNewUserConfigFromDialog(configDialog);
            UpdateOpenConfigButtonWithNumFilters();
            UpdateToggleContextButton();
            // @ts-ignore
            configDialog.close();
            configChangedCallback();
    });

    GetHtmlElement('config-dialog-cancel').addEventListener(
        // @ts-ignore
        'click', () => configDialog.close());

    GetHtmlElement('config-dialog-add-field-filter').addEventListener(
        'click', () => AddFieldFilterControlRowToDialog(fieldFiltersTable, ''));
}


function SaveNewUserConfigFromDialog(configDialog)
{
    const allInputs = configDialog.getElementsByTagName('input');
    let filters = [];
    for (const inputCtrl of allInputs) {
        if (inputCtrl.type === 'text' && inputCtrl.value != null && inputCtrl.value.trim().length !== 0) {
            filters.push(inputCtrl.value);
        }
    }

    SaveNewUserConfig(new UserConfig(
        filters, 
        // @ts-ignore
        GetDisabledAllFieldFiltersCheckbox().checked,
        // @ts-ignore
        GetShowUnchangedLinesCheckbox().checked,
        // @ts-ignore
        SanitizeNumberOfContextLinesInput(GetNumContextLinesControl().value),
        // @ts-ignore
        GetLimitMaxTileWidthCheckbox().checked,
        // @ts-ignore
        SanitizeMaxTileWidthInput(GetMaxTileWidthControl().value)
    ));
}


function SetCurrentFieldFiltersInDialog(fieldFiltersTable)
{
    fieldFiltersTable.replaceChildren();
    if (gUserConfig?.fieldFilters) {
        for (const filter of gUserConfig.fieldFilters) {
            AddFieldFilterControlRowToDialog(fieldFiltersTable, filter);
        }
    }
}


function AddFieldFilterControlRowToDialog(fieldFiltersTable, filterString)
{
    const newInput = document.createElement('input');
    newInput.type = 'text';
    newInput.setAttribute('list', 'config-dialog-suggested-fields');
    newInput.size = 30;
    newInput.value = filterString;
    newInput.title = 'Any field name that matches the given string case-insensitively will be hidden. A wildcard (*) can be used to represent any number of characters.';

    const newDeleteButton = document.createElement('button');
    newDeleteButton.classList.add('delete-filter-button');
    newDeleteButton.textContent = '❌';
    newDeleteButton.title = 'Remove the field filter on the left.';
    
    const newRow = document.createElement('tr');
    newRow.appendChild(document.createElement('td')).appendChild(newInput);
    newRow.appendChild(document.createElement('td')).appendChild(newDeleteButton);
    
    fieldFiltersTable.appendChild(newRow);

    newDeleteButton.addEventListener('click', () => {
        fieldFiltersTable.removeChild(newRow);
    });
}


function UpdateToggleContextButton()
{
    const toggleButton = GetToggleContextButton();
    toggleButton.textContent = '';

    const img = document.createElement('img');
    img.classList.add('img-in-button');
    img.classList.add('img-invert-for-dark-mode');
    if (gUserConfig?.showUnchangedLines) {
        img.src = CollapseSvg;
        toggleButton.title = 'Hide unchanged lines.';
    }
    else {
        img.src = ExpandSvg;
        toggleButton.title = 'Show all unchanged lines.';
    }

    toggleButton.appendChild(img);
}


function InitializeToggleContextButton(toggleContextCallback)
{
    GetToggleContextButton().addEventListener(
        'click', 
        () => {
            gUserConfig.showUnchangedLines = !gUserConfig.showUnchangedLines;
            SaveNewUserConfig(gUserConfig);
            UpdateToggleContextButton();
            toggleContextCallback();
    });

    UpdateToggleContextButton();
}


function SanitizeNumberOfContextLinesInput(value)
{
    return SanitizeIntegerInput(value, 0, DEFAULT_USER_CONFIG.numContextLines);
}


function SanitizeMaxTileWidthInput(value)
{
    // A max-width of below 300px for the *whole* tile seems unreasonable in all cases in my tests.
    // Note: Same value also used in historydiff.html for 'config-dialog-max-tile-width'.
    return SanitizeIntegerInput(value, 300, DEFAULT_USER_CONFIG.maxTileWidth);
}


function SanitizeIntegerInput(value, minAllowedValue, valueOnError)
{
    if (value === undefined) {
        return valueOnError;
    }
    if (Number.isInteger(value)) {
        return Math.max(value, minAllowedValue);
    }
    const asInt = parseInt(value);
    if (isNaN(asInt) || !Number.isInteger(asInt)) {
        return valueOnError;
    }
    return Math.max(asInt, minAllowedValue);
}
