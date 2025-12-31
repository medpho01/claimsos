export default class fileName {
  getPrefix = (admitted_at:string|null) => {
    const today = admitted_at?new Date(admitted_at):new Date();
    const date = today.getDate()
    const monthNameShort = today.toLocaleString('default', { month: 'short' });
    return date.toString()+"_"+monthNameShort+"_";
  }
  folderName = (name:string) => {
    return name;
  }
  patientFolderName = (name:string,admitted_at:string|null) => {
    return this.getPrefix(admitted_at)+name;
  }
}
