export function parseReferences(text){
 const result=[];const seen=new Set();
 const add=(equation,page)=>{const ref={equation:equation||null,page:page?Number(page):null};const key=JSON.stringify(ref);if(!seen.has(key)){seen.add(key);result.push(ref);}};
 for(const m of text.matchAll(/\[\[(?:eq:([\d]+[a-z]?)(?:\|p:(\d+))?|p:(\d+))\]\]/gi))add(m[1],m[2]||m[3]);
 for(const m of text.matchAll(/\b(?:eq(?:uation)?s?\.?)[ \t]*\(?([0-9]+[a-z]?)\)?(?:\s*(?:–|-|to)\s*\(?([0-9]+)\)?)?(?:[ ,·]*(?:on\s+)?(?:PDF\s+)?(?:page|p\.)\s*(\d+))?/gi)){
 add(m[1],m[3]);if(m[2]&&Number(m[2])-Number(m[1])<20)for(let n=Number(m[1])+1;n<=Number(m[2]);n++)add(String(n),m[3]);
 }
 for(const m of text.matchAll(/\b(?:page|p\.)\s*(\d+)\b/gi))add(null,m[1]);
 return result;
}
export function resolveReference(ref,index,overrides,pageCount){
 const custom=ref.equation&&overrides[ref.equation];
 if(custom)return {...custom,manual:true};
 const candidates=ref.equation?(index[ref.equation]||[]):[];
 const match=candidates.find(c=>c.page===ref.page)||(candidates.length===1?candidates[0]:null);
 if(match)return match;
 if(ref.page>=1&&ref.page<=pageCount)return {page:ref.page,y:null,fallback:true};
 return null;
}

// Structured citation tokens written by the model: [[eq:61|p:11]] or [[p:11]].
export const TOKEN = /\[\[(?:eq:(\d+[a-z]?)(?:\|p:(\d+))?|p:(\d+))\]\]/gi;
export const tokenRef = (eq, p1, p2) => ({equation: eq || null, page: Number(p1 || p2) || null});

// Plain-text mentions inside a sentence ("Eq. (61)", "Equations 57–58 on page 11", "p. 4"),
// returned with their position so they can be turned into links in place.
// A range links to its first equation.
const MENTION = /\b(?:eq(?:uation)?s?\.?\s*\(?(\d+[a-z]?)\)?(?:\s*(?:–|-|to|and)\s*\(?\d+[a-z]?\)?)?(?:,?\s*(?:on\s+)?(?:PDF\s+)?(?:page|p\.)\s*(\d+))?|(?:PDF\s+)?(?:page|p\.)\s*(\d+)\b)/gi;
export function findMentions(text) {
  const out = [];
  for (const m of text.matchAll(MENTION)) out.push({index: m.index, length: m[0].length, ref: {equation: m[1] || null, page: Number(m[2] || m[3]) || null}});
  return out;
}

// Paper equation number from a display equation's TeX source, e.g. \tag{61}.
export function tagOf(tex) {
  return tex?.match(/\\tag\*?\{\s*\(?(\d+[a-z]?)\)?\s*\}/)?.[1] ?? null;
}

// Verbatim quotes from the paper: [[quote:7|exact words]] (page, then the words).
export const QUOTE = /\[\[quote:(\d+)\|([^\]]{3,800}?)\]\]/gi;

// Anchored citations: [[cite:7|a few exact words]] point at the supporting passage on a page.
export const ANCHOR = /\[\[cite:(\d+)\|([^\]]{3,400}?)\]\]/gi;
