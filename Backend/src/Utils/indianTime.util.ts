export function getIndianTimeISO(addMinutes:number = 0) {
    const date = new Date();
    if (addMinutes) {
        date.setMinutes(date.getMinutes() + addMinutes);
    }
    const istOffset = 5.5 * 60 * 60 * 1000; 
    const istDate = new Date(date.getTime() + istOffset);
    return istDate.toISOString().replace('Z', '');
}
