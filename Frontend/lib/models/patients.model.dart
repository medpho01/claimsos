class Patients {
  final String id;
  final String firstName;
  final String lastName;
  final String phone;
  final DateTime admittedOn;

  Patients({
    required this.id,
    required this.firstName,
    required this.lastName,
    required this.phone,
    required this.admittedOn,
  });

  Map<String, dynamic> toJson() => {
    'firstName': firstName,
    'lastName': lastName,
    'phone': phone,
    'admittedOn': admittedOn.toIso8601String(),
  };
}
