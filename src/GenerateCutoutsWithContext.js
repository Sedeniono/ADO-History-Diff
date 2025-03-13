// @ts-check


/**
 * @typedef Cutout
 * @type {object}
 * @property {HTMLDivElement} div The html element that contains the cutout.
 * @property {number} top The top position of the cutout in pixels. 0 means that the cutout starts at the top of the original element.
 * @property {number} bottom The bottom position of the cutout in pixels. `originalHeight` means that the cutout ends at the bottom of the original element.
 */

/**
 * @typedef Cutouts
 * @type {object}
 * @property {Cutout[]} cutouts All cutouts.
 * @property {number} originalHeight The total height of the original html element in pixels, from which the cutouts were generated.
 */



/**
 * Helper function that can be used to get the line height of text in `el`.
 * Based on https://stackoverflow.com/a/4515470/3740047
 * 
 * @param {HTMLElement} el 
 */
export function GetLineHeightInPixel(el)
{
    const temp = document.createElement(el.nodeName);
    temp.style = `margin:0; padding:0; font-family:${el.style.fontFamily || "inherit"}; font-size:${el.style.fontSize || "inherit"}`;
    temp.innerHTML = "A";

    document.body.appendChild(temp);
    const ret = temp.clientHeight;
    temp.parentNode?.removeChild(temp);
    return ret;
}


/**
 * Helper function to create a deep copy of the cutouts.
 * @param {Cutouts} cutouts The cutouts to clone.
 */
export function DeepCloneCutouts(cutouts)
{
    /** @type {Cutouts} */
    const cutoutsClone = {cutouts: [], originalHeight: cutouts.originalHeight};
    for (const cutout of cutouts.cutouts) {
        const cutoutClone = {
            div: /** @type {HTMLDivElement} */ (cutout.div.cloneNode(true)), 
            top: cutout.top, 
            bottom: cutout.bottom
        };
        cutoutsClone.cutouts.push(cutoutClone);
    }
    return cutoutsClone;
}


/**
 * The goal of this function is to take some arbitrary piece of html in `originalHtmlElement` and find
 * some specific html nodes in it + some context above and below each node. I.e. it creates new html nodes
 * that represent the context of the target nodes, where the size of the context is determined by the
 * `numContextLines` parameter (`numContextLines` above and and below, where each line is assumed to have
 * a height of `lineHeightInPixel`; the `lineHeightInPixel` can be queries via GetLineHeightInPixel()).
 * The target nodes are identified by their html element names in `targetHtmlElementNames`, such as "ins"
 * or "del".
 * If cutouts overlap or are at most `mergingToleranceInPixel` pixels away from each other, they are merged.
 *
 * Note that `originalHtmlElement` must be in the DOM (so that sizes can be calculated).
 *
 * It is actually very difficult or maybe impossible to extract some specific element + some context from an
 * arbitrary html. Consider cases where the element is e.g. in a table, or the context would need to cut-off
 * some table or image, or if the element is in the middle of an enumeration. Getting a standalone "context"
 * html is basically impossible.
 * Therefore, a different approach is chosen here: We create a **full** clone of the whole `originalHtmlElement`,
 * put it into a "div" with a height matching the target node, and then use the css property `overflow` to 
 * actually only show the desired "slice". If there are multiple target nodes in `originalHtmlElement`, we
 * create a full clone each time of `originalHtmlElement` but show a different "slice" each time.
 * 
 * @returns {Promise<Cutouts|undefined>} The cutouts or `undefined` if no cutouts could be found.
 * @param {Element} originalHtmlElement
 * @param {string[]} targetHtmlElementNames
 * @param {number} numContextLines
 * @param {number} lineHeightInPixel
 * @param {number} mergingToleranceInPixel
 */
export async function GenerateCutoutsWithContext(
    originalHtmlElement, targetHtmlElementNames, numContextLines, lineHeightInPixel, mergingToleranceInPixel)
{
    // We need all images to have loaded to get the correct extents of the elements.
    // https://stackoverflow.com/a/60382635/3740047
    const imgPromises = [];
    for (const img of originalHtmlElement.querySelectorAll("img")) {
        if (!img.complete) {
            const p = new Promise(resolve => { 
                img.addEventListener("load", resolve);
                img.addEventListener("error", resolve);
            });
            imgPromises.push(p);
        }
    }

    if (imgPromises.length > 0) {
        await Promise.all(imgPromises);
    }

    const origRect = originalHtmlElement.getBoundingClientRect();
    const origTop = origRect.top;
    const origBottom = origRect.bottom;
    
    // +1 to ensure we really don't cut anything off. It also causes merging of
    // contexts on successive lines.
    const numContextInPixel = numContextLines * lineHeightInPixel + 1;

    /** @type {Cutout[]} */
    let cutouts = [];

    let prevCutout = null;
    const origTargetNodes = originalHtmlElement.querySelectorAll(targetHtmlElementNames.join(","));
    for (const origTargetNode of origTargetNodes) {
        // Find the top and bottom of the target element.
        const origTargetNodeExtent = GetTopAndBottomPositionOf(origTargetNode);
        const origTargetTop = origTargetNodeExtent.top;
        let origTargetBottom = origTargetNodeExtent.bottom;

        // If the target node is empty, ensure that we nevertheless show a meaningful context.
        origTargetBottom = Math.max(origTargetBottom, origTargetTop + lineHeightInPixel);

        // Get the top and bottom position of the "context" that we want to show. The positions are in pixels and relative
        // to the top of `originalHtmlElement`. So contextTop=0 means at the very top, and contextBottom=originalRect.height
        // means at the very bottom.
        let curCutoutTop = Math.max(0, origTargetTop - numContextInPixel - origTop);
        let curCutoutBottom = Math.max(curCutoutTop, Math.min(origBottom, origTargetBottom + numContextInPixel) - origTop);

        if (curCutoutTop <= mergingToleranceInPixel) {
            curCutoutTop = 0;
        }
        if (origRect.height - curCutoutBottom <= mergingToleranceInPixel) {
            curCutoutBottom = origRect.height;
        }

        const contextHeight = curCutoutBottom - curCutoutTop;        
        
        // Merge successive overlapping cutouts.
        if (prevCutout && prevCutout.bottom + mergingToleranceInPixel >= curCutoutTop) { 
            prevCutout.top = Math.min(prevCutout.top, curCutoutTop);
            prevCutout.bottom = Math.max(prevCutout.bottom, curCutoutBottom);
            const newPrevHeight = prevCutout.bottom - prevCutout.top;
            prevCutout.div.style.height = `${newPrevHeight}px`;
        }
        else {
            const newCutoutDiv = document.createElement("div");
            newCutoutDiv.classList.add('cutout-base');
            // Main trick: Set the "overflow" and "height" to show only a cut-out of the original. Below, we will scroll
            // its content to the desired position.
            newCutoutDiv.style.cssText 
                = `display: block; overflow: hidden; height: ${contextHeight}px;`;

            // Deep clone the original html element.
            for (const child of originalHtmlElement.childNodes) {
                newCutoutDiv.appendChild(child.cloneNode(true));
            }

            prevCutout = {div: newCutoutDiv, top: curCutoutTop, bottom: curCutoutBottom};
            cutouts.push(prevCutout);
        }
    }
    
    if (cutouts.length === 0) {
        return undefined;
    }

    if (cutouts.length === 1 && cutouts[0].top <= 0 && cutouts[0].bottom >= origRect.height) {
        // We got a single cutout covering the whole original element. So we don't really
        // have a meaningful cutout.
        return undefined;
    }

    for (const cutout of cutouts) {
        cutout.div.scroll({left: 0, top: cutout.top, behavior: "instant"});
    }

    // By assumption of the whole function, all images have already been loaded. Hence, the images' heights are valid above,
    // and we should have scrolled to the correct position in the loop above. Nevertheless, somehow the browser's layout engine
    // (and especially its "scroll anchoring" feature) can cause incorrect scrolling, especially if the browser's cache is 
    // disabled. As a workaround, we apply the scrolling again in the next tick.
    // https://stackoverflow.com/q/79424984/3740047
    setTimeout(() => {
        for (const cutout of cutouts) {
            cutout?.div?.scroll({left: 0, top: cutout.top, behavior: "instant"});
        }
    }, 0);

    return {cutouts, originalHeight: origRect.height};
}


function GetTopAndBottomPositionOf(htmlNode)
{
    // If the htmlNode itself or children of it have `display: inline`, `htmlNode.getBoundingClientRect()` 
    // will not take the inline node's height into account. For example, take `<ins><img...></ins>` 
    // and assume that `htmlNode` is <ins>: Then `htmlNode.getBoundingClientRect().height` will ignore the
    // image's height because <ins> is treated as inline by default.
    // Using selectNodeContents() and then calling getBoundingClientRect() doesn't seem to have that problem.
    // However, it does cut-off e.g. the bottom rounding of the "g" in the text "ggg". Hence we need to take
    // the union with the htmlNode's bounding rectangle.
    const range = document.createRange();
    range.selectNodeContents(htmlNode);
    const selectRect = range.getBoundingClientRect();

    const htmlRect = htmlNode.getBoundingClientRect();
    const top = Math.min(selectRect.top, htmlRect?.top);
    const bottom = Math.max(selectRect.bottom, htmlRect?.bottom);
    return {top, bottom};
}
