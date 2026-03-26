export default class fileName {
  private counter = 0;

  getPrefix = (admitted_at: string | null) => {
    const today = admitted_at ? new Date(admitted_at) : new Date();
    const date = today.getDate()
    const monthNameShort = today.toLocaleString('default', { month: 'short' });
    return date.toString() + "_" + monthNameShort + "_";
  }
  folderName = (name: string) => {
    return name.replace(" ", "_");
  }
  patientFolderName = (name: string, admitted_at: string | null) => {
    return (this.getPrefix(admitted_at) + name).replace(" ", "_");
  }

  imageName = (firstName: string, lastName: string, phone: string, customName?: string) => {
    const timestamp = `${Date.now()}_${this.counter++}`;
    const safeFirst = firstName?.replace(/[^a-zA-Z0-9]/g, '');
    const safeLast = lastName?.replace(/[^a-zA-Z0-9]/g, '');
    // Sanitize custom name if provided
    const safeCustomName = customName?.replace(/[^a-zA-Z0-9_-]/g, '').trim();

    let result = `${this.getPrefix(null)}${safeFirst}_${safeLast}`;
    if (safeCustomName) {
      result += `_${safeCustomName}`;
    }
    result += `_${timestamp}`;
    result = result.replace(" ", "_");
    return result;
  }
}
