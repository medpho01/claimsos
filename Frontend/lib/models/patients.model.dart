class Patients {
  final String id;
  final String firstName;
  final String lastName;
  final String phone;
  final DateTime admittedOn;
  final String admissionType;
  Patients({
    required this.id,
    required this.firstName,
    required this.lastName,
    required this.phone,
    required this.admittedOn,
    required this.admissionType,
  });

  Map<String, dynamic> toJson() => {
    'firstName': firstName,
    'lastName': lastName,
    'phone': phone,
    'admittedOn': admittedOn.toIso8601String(),
    'admissionType': admissionType,
  };
}
