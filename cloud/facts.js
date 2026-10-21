// Factual drafting is deliberately usable without a model or the Mac worker.
const escWords = s => String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const words={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
const numberWords='(?:'+Object.keys(words).concat(['hundred','thousand','and','point']).join('|')+')';
const numeric='(?:\\d[\\d,]*(?:\\.\\d{1,2})?|'+numberWords+'(?:[ -]+'+numberWords+')*)';
const defect=/\b(?:fractur\w*|crack\w*|chip\w*|repair\w*|treat\w*|scratch\w*|saw[ -]?marks?|dye\w*|dyed|epoxy|glue\w*|resin|stabili[sz]\w*|heated|fill(?:ed|ing)|coat\w*|pitt(?:ed|ing))\b/i;
const uncertain=/\b(?:about|around|maybe|approximately|guess|between|or|unsure|not sure|one eighty)\b/i;
function valueNumber(text){text=text.toLowerCase().replace(/,/g,'').trim();if(/^\d+(?:\.\d+)?$/.test(text))return Number(text);let sum=0,part=0;for(const w of text.replace(/-/g,' ').split(/\s+/)){if(w==='and')continue;if(w==='hundred')part=(part||1)*100;else if(w==='thousand'){sum+=(part||1)*1000;part=0;}else if(w in words)part+=words[w];else return null;}return sum+part;}
function parts(text){return text.split(/(?<=[.!?;])\s+|\n+/).map(x=>x.trim()).filter(Boolean);}
export function extractFacts(input,settings={}){
 const source=String(input||'').slice(0,20000),warnings=[];let text=source;
 for(const [heard,correct]of Object.entries(settings.corrections||{})){if(heard.trim())text=text.replace(new RegExp('\\b'+escWords(heard)+'\\b','gi'),String(correct));}
 const clauses=parts(text),terms=[...(settings.terminology||[]),'Kentucky agate','Laguna agate','agate','quartz','jasper','geode','amethyst','fluorite','calcite','petrified wood','mineral specimen','lapidary material'].sort((a,b)=>b.length-a.length);
 let material='';const labeled=text.match(/\bmaterial\s*(?:is|:|=)\s*([^.;\n]+?)(?=\s+(?:price|condition|weight)\s*:|[.;\n]|$)/i);if(labeled)material=labeled[1].trim();
 if(!material)material=terms.find(t=>new RegExp('\\b'+escWords(t)+'\\b','i').test(text))||'';
 const number=text.match(new RegExp('(?:\\b(?:number|specimen|no\\.?)\\s*[:#]?\\s*|#)('+numeric+')','i'));
 const amounts=[];for(const clause of clauses){for(const pattern of [new RegExp('\\$\\s*('+numeric+')','gi'),new RegExp('('+numeric+')\\s*(?:dollars?|USD)\\b','gi'),new RegExp('\\b(?:asking price|price|asking)\\s*(?:is|:|of)?\\s*\\$?\\s*('+numeric+')','gi')])for(const m of clause.matchAll(pattern)){const n=valueNumber(m[1]);if(n!==null&&n>0&&n<=1000000){if(uncertain.test(clause))warnings.push('Confirm the exact asking price; the narration contains uncertainty.');else amounts.push(Math.round(n*100));}}}
 const unique=[...new Set(amounts)];let price_cents=unique.length===1?unique[0]:null;if(unique.length>1)warnings.push('Conflicting asking prices. Confirm one exact amount.');if(!price_cents)warnings.push('Price needs confirmation');
 let locality='';const from=text.match(/\b(?:from|locality\s*(?:is|:))\s+([^.;\n]+?)(?=,?\s*(?:weighs?|asking|price|condition|polished|nice|minor|small)|[.;\n]|$)/i);if(from)locality=from[1].trim().replace(/[, ]+$/,'');
 const wm=text.match(new RegExp('('+numeric+')\\s*(ounces?|oz\\b|pounds?|lbs?\\b|grams?|g\\b|kilograms?|kg\\b)','i'));let weight='';if(wm){const n=valueNumber(wm[1]);const unit=/^(ounce|oz)/i.test(wm[2])?'oz':/^(pound|lb)/i.test(wm[2])?'lb':/^(kilogram|kg)/i.test(wm[2])?'kg':'g';if(n>0)weight=n+' '+unit;}
 const disclosures=clauses.filter(c=>defect.test(c)).map(c=>c.replace(/^\s*(?:condition|disclosure)\s*[:=]\s*/i,'').replace(/[.;]+$/,''));
 let condition=disclosures.join('. ');if(!condition&&/\bno known defects\b/i.test(text))condition='No known defects reported by the seller';if(!condition){const c=text.match(/\bcondition\s*(?::|is)\s*([^.;\n]+)/i);condition=c?c[1].trim():'';}if(!condition||/not checked|uninspected/i.test(condition))warnings.push('Inspect and confirm condition before publishing');
 const finish=/\b(?:cut and polished|cut or polished)\b/i.test(text)?'cut and polished':/\bpolished\b/i.test(text)?'polished':/\brough\b/i.test(text)?'rough':'';
 if(!material)warnings.push('Material needs confirmation');
 return {material,specimen_number:number?String(valueNumber(number[1])??number[1]):'',locality,price_cents,weight,finish,condition,transcript:text,source_transcript:source,original_transcript:source,corrected_transcript:text,notes:text,warnings};
}
export function generateListings(r,settings={}){
 const title=[r.material||'Mineral specimen',r.specimen_number?'No. '+r.specimen_number:''].filter(Boolean).join(' — ');
 const groups=[r.material&&((r.specimen_number?'Specimen '+r.specimen_number+': ':'')+r.material+'.'),r.locality&&'Locality: '+r.locality+'.',r.weight&&'Weight: '+r.weight+'.',r.dimensions&&'Dimensions: '+r.dimensions+'.',r.finish&&'Finish: '+r.finish+'.',r.condition&&'Condition: '+r.condition.replace(/[.!]+$/,'')+'.'].filter(Boolean);
 const appearance=parts(r.source_transcript||r.notes||'').filter(c=>/\b(?:banding|bands|red|yellow|blue|green|purple|translucent|crystal|pattern)\b/i.test(c)&&!defect.test(c)&&!/(?:\$|price|dollars|number|from |publish|ignore)/i.test(c));
 const description=[groups.join(' '),...appearance,'Review the photographs and condition notes for this specimen’s details.',settings.shipping?.note||''].filter(Boolean).join('\n\n');
 const tags=[...new Set([r.material,r.finish,r.locality,'mineral specimen','rock collection','lapidary material'].filter(Boolean).filter(t=>t.length<=20))].slice(0,13);
 const why=listingReasons(r,tags);
 return {website:{title:title.slice(0,140),description,price_cents:r.price_cents,alt_text: title,why:why.website},etsy:{title:[r.material,r.finish,r.locality].filter(Boolean).join(' · ').slice(0,140),description,tags,price_cents:r.price_cents,why:why.etsy},ebay:{title:[r.material,r.finish,r.specimen_number?'#'+r.specimen_number:''].filter(Boolean).join(' ').slice(0,80),description,price_cents:r.price_cents,item_specifics:{Material:r.material,...(r.locality?{Locality:r.locality}:{}),...(r.weight?{Weight:r.weight}:{})},why:why.ebay}};
}
// Plain-language notes shown beside each draft so the seller can see why it reads the way it does.
function listingReasons(r,tags){
 const missing=[!r.locality&&'locality (collectors filter and search by where it was found)',!r.weight&&'weight (needed for accurate shipping quotes)',!r.dimensions&&'measured size (cuts down on “how big is it?” questions)'].filter(Boolean);
 const shared=['Every fact comes from what you said or typed. Nothing is guessed, so nothing has to be walked back after a sale.',r.condition?'Condition notes are copied word for word. Being upfront about chips and repairs prevents “not as described” returns.':'There’s no condition note yet. Add one, even “no known defects,” before you publish.',r.price_cents?'The price is exactly what you set, and it’s the same on every channel. Etsy and eBay take roughly 10–15% in fees, so raise it there if you want to keep the same take-home amount.':'There’s no price yet. Set one before you publish.',missing.length?'Worth adding: '+missing.join('; ')+'.':'',r.video?'This piece comes from a tray video, so buyers can see it turning in real light. That builds trust on one-of-a-kind stones.':''].filter(Boolean);
 return {
  website:['The title leads with the material and specimen number, so you can match the listing to the stone on your bench and in the video.',...shared],
  etsy:['The Etsy title follows material · finish · locality order. Those are the words buyers type first, and it stays under Etsy’s 140-character limit.',`${tags.length} of 13 tags are used. Tags over 20 characters are left out because Etsy rejects them.`,'Etsy only allows handmade, vintage or craft-supply items. Your eligibility setting decides which category it goes in.',...shared],
  ebay:['The eBay title is capped at 80 characters and puts the material and finish first, since eBay search weights the start of the title most.','Item specifics (Material, Locality, Weight) are filled in so the listing shows up when buyers use eBay’s filters.',...shared]
 };
}
export function generateRecord(transcript,photos=[],settings={}){
 const facts=extractFacts(transcript,settings),now=new Date().toISOString();const r={...facts,id:crypto.randomUUID(),quantity:1,status:'draft',stock_verified:false,reviewed:false,seller_work_confirmed:false,source:'seller',photos,video:null,created_at:now,updated_at:now,etsy_eligibility:settings.default_etsy_eligibility||'seller_made_altered'};
 r.listings=generateListings(r,settings);r.title=r.listings.website.title;r.description=r.listings.website.description;r.drafting_engine='factual rules (cloud; no inference charge)';if(!photos.length)r.warnings.push('Add at least one photograph');return r;
}
