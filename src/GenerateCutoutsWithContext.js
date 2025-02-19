// @ts-check

// Helper function that can be used to get the line height of text in `el`.
// Based on https://stackoverflow.com/a/4515470/3740047
export function GetLineHeightInPixel(el)
{
    const temp = document.createElement(el.nodeName);
    temp.style = `margin:0; padding:0; font-family:${el.style.fontFamily || "inherit"}; font-size:${el.style.fontSize || "inherit"}`;
    temp.innerHTML = "A";

    document.body.appendChild(temp);
    const ret = temp.clientHeight;
    temp.parentNode.removeChild(temp);
    return ret;
}


// The goal of this function is to take some arbitrary piece of html in `originalHtmlElement` and find
// some specific html nodes in it + some context above and below each node. I.e. it creates new html nodes
// that represent the context of the target nodes, where the size of the context is determined by the
// `numContextLines` parameter (`numContextLines` above and and below, where each line is assumed to have
// a height of `lineHeightInPixel`).
// The target nodes are identified by their html element names in `targetHtmlElementNames`, such as "ins"
// or "del".
// If cutouts overlap, they are merged.
//
// Note that `originalHtmlElement` must be in the DOM (so that sizes can be calculated).
//
// It is actually very difficult or maybe impossible to extract some specific element + some context from an
// arbitrary html. Consider cases where the element is e.g. in a table, or the context would need to cut-off
// some table or image, or if the element is in the middle of an enumeration. Getting a standalone "context"
// html is basically impossible.
// Therefore, a different approach is chosen here: We create a **full** clone of the whole `originalHtmlElement`,
// put it into a "div" with a height matching the target node, and then use the css property `overflow` to 
// actually only show the desired "slice". If there are multiple target nodes in `originalHtmlElement`, we
// create a full clone each time of `originalHtmlElement` but show a different "slice" each time.
export async function GenerateCutoutsWithContext(originalHtmlElement, targetHtmlElementNames, numContextLines, lineHeightInPixel)
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

    const originalRect = originalHtmlElement.getBoundingClientRect();
    const originalTop = originalRect.top;
    const originalBottom = originalRect.bottom;
    
    // +1 to ensure we really don't cut anything off. It also causes merging of
    // contexts on successive lines.
    const numContextInPixel = numContextLines * lineHeightInPixel + 1;

    let cutouts = [];
    let prevCutout = null;
    const originalTargetNodes = originalHtmlElement.querySelectorAll(targetHtmlElementNames.join(","));
    for (const targetNode of originalTargetNodes) {
        // Find the top and bottom of the target element.
        const targetNodeExtent = GetTopAndBottomPositionOf(targetNode);
        const targetTop = targetNodeExtent.top;
        let targetBottom = targetNodeExtent.bottom;

        // If the target node is empty, ensure that we nevertheless show a meaningful context.
        targetBottom = Math.max(targetBottom, targetTop + lineHeightInPixel);

        // Get the top and bottom position of the "context" that we want to show. The positions are in pixels and relative
        // to the top of `originalHtmlElement`.
        const contextTop = Math.max(0, targetTop - numContextInPixel - originalTop);
        const contextBottom = Math.max(contextTop, Math.min(originalBottom, targetBottom + numContextInPixel) - originalTop);
        const contextHeight = contextBottom - contextTop;        
        
        // Merge successive overlapping cutouts.
        if (prevCutout && prevCutout.bottom >= contextTop) { 
            prevCutout.top = Math.min(prevCutout.top, contextTop);
            prevCutout.bottom = Math.max(prevCutout.bottom, contextBottom);
            const newPrevHeight = prevCutout.bottom - prevCutout.top;
            prevCutout.div.style.height = `${newPrevHeight}px`;
        }
        else {
            const newCutoutDiv = document.createElement("div");
            newCutoutDiv.classList.add('cutoutCls');
            // Main trick: Set the "overflow" and "height" to show only a cut-out of the original. Below, we will scroll
            // its content to the desired position.
            newCutoutDiv.style.cssText 
                = `display: block; overflow: hidden; height: ${contextHeight}px;`;

            // Deep clone the original html element.
            for (const child of originalHtmlElement.childNodes) {
                newCutoutDiv.appendChild(child.cloneNode(true));
            }

            prevCutout = {div: newCutoutDiv, top: contextTop, bottom: contextBottom};
            cutouts.push(prevCutout);
        }
    }
    
    if (cutouts.length === 1 && cutouts[0].top <= 0 && cutouts[0].bottom >= originalRect.height) {
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

    return cutouts;
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
