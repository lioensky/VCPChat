const art = {
    lamp: ['#ffe0a2', '<ellipse cx="31" cy="53" rx="17" ry="4" fill="#668985"/><path d="M31 50V36L20 22l17-8" fill="none" stroke="#719d98" stroke-width="5" stroke-linejoin="round"/><path d="M34 10q8-3 14 5l7 10-24-2z" fill="#66ab9d"/><path d="m32 23 22 2q-11 7-22-2" fill="#ffdb86"/><circle cx="20" cy="22" r="3" fill="#cae8df"/>'],
    tv: ['#accfff', '<rect x="5" y="12" width="54" height="35" rx="5" fill="#34475c"/><rect x="8" y="15" width="48" height="28" rx="3" fill="#85afe0"/><path d="m8 38 14-13 11 9 10-12 13 12v9H8z" fill="#527fa9"/><path d="M29 47h6v5h10v3H19v-3h10z" fill="#64798a"/>'],
    washer: ['#a7dbea', '<rect x="13" y="5" width="39" height="53" rx="6" fill="#8cabb8"/><rect x="11" y="4" width="38" height="52" rx="5" fill="#e0eeee"/><path d="M14 16h32" stroke="#adc6ce"/><circle cx="41" cy="11" r="3" fill="#709ba9"/><circle cx="30" cy="35" r="14" fill="#92b7c6"/><circle cx="30" cy="35" r="10" fill="#395c75"/><path d="M21 36q5-4 10 0t8-1a9 9 0 0 1-18 1" fill="#7ac3d2"/>'],
    ac: ['#b2e6d7', '<rect x="4" y="14" width="56" height="29" rx="8" fill="#96b4b4"/><rect x="4" y="12" width="55" height="26" rx="8" fill="#dfefeb"/><path d="M10 32h42" stroke="#7faaaa" stroke-width="3"/><circle cx="50" cy="20" r="2" fill="#5eb69f"/><path d="M21 45q0 5-4 8m15-8v9m11-9q0 5 4 8" fill="none" stroke="#80cabe" stroke-width="3" stroke-linecap="round"/>'],
    dishwasher: ['#dbcaeb', '<rect x="11" y="6" width="42" height="51" rx="5" fill="#a49fb8"/><rect x="11" y="5" width="39" height="49" rx="4" fill="#e4dfed"/><rect x="16" y="12" width="23" height="4" rx="2" fill="#858098"/><circle cx="44" cy="14" r="2" fill="#7eafa1"/><rect x="16" y="22" width="29" height="25" rx="3" fill="#aba7bf"/><path d="M20 40l4-11m3 11 4-11m3 11 4-11m-19 12h22" fill="none" stroke="#fcf2df" stroke-width="3" stroke-linecap="round"/>'],
    fridge: ['#badcf2', '<rect x="15" y="4" width="36" height="55" rx="6" fill="#7997ab"/><rect x="13" y="3" width="35" height="54" rx="5" fill="#dcebf2"/><path d="M14 32h33" stroke="#89a8bb" stroke-width="2"/><path d="M20 18v9m0 10v7" stroke="#728da1" stroke-width="3" stroke-linecap="round"/><rect x="33" y="10" width="9" height="4" rx="2" fill="#87bdbb"/>'],
    generic: ['#c1ced6', '<rect x="13" y="15" width="39" height="36" rx="10" fill="#8298a1"/><rect x="12" y="12" width="38" height="35" rx="10" fill="#d7e4e4"/><circle cx="31" cy="29" r="8" fill="#809da5"/><circle cx="31" cy="29" r="4" fill="#c4e8db"/>'],
};
const categories = new Map(Object.entries({
    light: 'lamp', lamp: 'lamp', television: 'tv', tv: 'tv', washer: 'washer',
    washingmachine: 'washer', aircondition: 'ac', airconditioner: 'ac',
    acpartner: 'ac', dishwasher: 'dishwasher', fridge: 'fridge', refrigerator: 'fridge',
}));
const names = [['洗碗机','dishwasher'],['洗衣机','washer'],['冰箱','fridge'],['空调','ac'],['电视','tv'],['台灯','lamp']];
export function deviceKind(model, name) {
    return categories.get(String(model).toLowerCase().split('.')[1])
        || names.find(([label]) => String(name).includes(label))?.[1] || 'generic';
}
export function paintDeviceIcon(host, kind) {
    if (host.dataset.kind === kind) return;
    host.dataset.kind = kind;
    const [color, paths] = art[kind];
    // Only local, literal artwork enters the SVG; device strings never enter markup.
    host.innerHTML = `<svg aria-hidden="true" viewBox="0 0 64 64"><ellipse cx="32" cy="57" rx="21" ry="3" fill="${color}" opacity=".24"/>${paths}</svg>`;
}