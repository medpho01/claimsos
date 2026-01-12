class Patients {
  final String id;
  final String firstName;
  final String lastName;
  final String phone;
  final DateTime admittedOn;
  final String admissionType;
  // PMJAY fields
  final String? pmjayCaseNumber;
  final String? scheme;
  final String? treatmentProcedure;
  final String? latestStatus;
  final double? claimAmount;

  Patients({
    required this.id,
    required this.firstName,
    required this.lastName,
    required this.phone,
    required this.admittedOn,
    required this.admissionType,
    this.pmjayCaseNumber,
    this.scheme,
    this.treatmentProcedure,
    this.latestStatus,
    this.claimAmount,
  });

  Map<String, dynamic> toJson() => {
    'firstName': firstName,
    'lastName': lastName,
    'phone': phone,
    'admittedOn': admittedOn.toIso8601String(),
    'admissionType': admissionType,
    if (pmjayCaseNumber != null) 'pmjayCaseNumber': pmjayCaseNumber,
    if (scheme != null) 'scheme': scheme,
    if (treatmentProcedure != null) 'treatmentProcedure': treatmentProcedure,
    if (latestStatus != null) 'latestStatus': latestStatus,
    if (claimAmount != null) 'claimAmount': claimAmount,
  };
}
