// SPDX-License-Identifier: MIT
// GitHub link: https://github.com/Sedeniono/ADO-History-Diff

// @ts-check


// @ts-ignore
import * as htmldiff from 'node-htmldiff';


const gReplaceEntityMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '/': '&#x2F;',
    '`': '&#x60;',
    '=': '&#x3D;'
  };
  
// Escapes some piece of text so that it can be safely put into an html element.
// https://stackoverflow.com/a/12034334/3740047
export function EscapeHtml(string) {
    return String(string).replace(/[&<>"'`=\/]/g, function (s) {
        return gReplaceEntityMap[s];
    });
}


// Escapes some text so that it gets interpreted as normal text in a regex.
export function EscapeForRegex(str)
{
    // https://stackoverflow.com/a/67227435
    return str.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}


export function RemoveStyle(string) 
{
    return String(string).replace(/\<style\>.*?\<\/style\>/gms, '');
}


export function FormatDate(date)
{
    const dateFormatOptions = {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false};
    return date.toLocaleDateString(undefined, dateFormatOptions);
}


export function GetIdentityName(identity) 
{
    const name = identity?.displayName;

    // I have seen some automatic changes to work items being done by a user called 'Microsoft.TeamFoundation.System <...>'
    // in a ADO server instance, where '...' was some UUID. Depending on the place where that user showed up, sometimes the
    // '<...>' part was omitted and sometimes not. E.g. the "revisedBy" property of work item updates includes it, while e.g. 
    // "System.ChangedBy" does not contain it. Very strange. If '<...>' is present, the 'identity' also does not contain
    // an avatar. Unfortunately, at least in the case of work item updates, we only have the "revisedBy" property as reliable
    // source for the author of the changes; some update revisions simply contain no other property with that info. So  we 
    // cannot simply use some other source that does not contain the '<...>'.
    // The official ADO history tab does not show the '<...>'.
    // Therefore: Simply strip out the '<...>' directly. And ignore that we cannot show an avatar image (in GetIdentityAvatarHtml()).
    if (name?.startsWith('Microsoft.TeamFoundation.System <')) {
        return 'Microsoft.TeamFoundation.System';
    }

    return EscapeHtml(name ?? 'UNKNOWN NAME');
}


export function GetIdentityAvatarHtml(identity) 
{
    // According to the documentation (https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/identityreference),
    // 'imageUrl' is deprecated and '_links.avatar' should be used.
    const avatarUrl = identity?._links?.avatar?.href ?? '';
    const avatarHtml = avatarUrl ? `<img src="${avatarUrl}" class="inlineAvatar" alt="Avatar">` : '';
    return avatarHtml;
}


export function DiffHtmlText(oldValue, newValue) 
{
    // Remove <style> in the html content: Having it in the <body> is illegal. ADO itself doesn't insert them
    // (as far as I know), but some tools (e.g. JIRA to ADO conversion scripts) might insert them. Also, you can
    // edit e.g. the description field in the browser's debugger and insert any html there, and ADO apparently
    // stores it in its database. Thus, we end up getting <style> here, too. ADO itself actually also removes the 
    // <style> tag when loading a work item in the UI.
    const oldValueFixed = RemoveStyle(oldValue ?? '');
    const newValueFixed = RemoveStyle(newValue ?? '');
    return htmldiff(oldValueFixed, newValueFixed, 'diffCls'); 
}


// Based on https://stackoverflow.com/a/56824017/3740047
export async function FilterInPlace(array, includeIfTruePredicate) 
{
    let iOut = 0;
    for (let i = 0; i < array.length; ++i) {
        const incl = await includeIfTruePredicate(array[i]);
        if (incl) {
            array[iOut++] = array[i];
        }
    }
    array.length = iOut;
}


// https://stackoverflow.com/a/2140723/3740047
export function StringsAreEqualCaseInsensitively(a, b)
{    
    return typeof a === 'string' && typeof b === 'string'
        ? a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
        : a === b;
}


// Checks if "str" matches "rule", where "rule" may contain "*" as wildcard to match any number of characters.
// The match is case-insensitive.
// https://stackoverflow.com/a/32402438/3740047
export function StringsMatchCaseInsensitiveWithWildcard(str, rule)
{  
    const regexRule = "^" + rule.split("*").map(EscapeForRegex).join(".*") + "$";
    return new RegExp(regexRule, "i").test(str);
}
