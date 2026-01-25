import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:camera/camera.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../widgets/loading_skeleton.dart';
import '../widgets/empty_state.dart';
import 'patient_details.screen.dart';
import 'patient_form.screen.dart';
import 'login.screen.dart';
import 'camera.screen.dart';

enum PatientFilter { all, admitted, discharged }

enum SortOption { nameAsc, nameDesc, newest, oldest }

class PatientListScreen extends StatefulWidget {
  const PatientListScreen({super.key});

  @override
  State<PatientListScreen> createState() => _PatientListScreenState();
}

class _PatientListScreenState extends State<PatientListScreen> {
  final ApiService _api = ApiService();
  final TextEditingController _searchController = TextEditingController();

  List<Map<String, dynamic>> _allPatients = [];
  List<Map<String, dynamic>> _filteredPatients = [];
  bool _isLoading = true;
  String? _errorMessage;
  PatientFilter _currentFilter = PatientFilter.admitted;
  SortOption _currentSort = SortOption.newest;

  @override
  void initState() {
    super.initState();
    _fetchPatients();
    _searchController.addListener(_filterAndSortPatients);
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<void> _fetchPatients() async {
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    try {
      final response = await _api.get('/patient/getActivePatients');

      if (!mounted) return;
      if (response.statusCode == 200) {
        final data = response.data['data'] as List?;
        setState(() {
          _allPatients =
              data?.map((e) => e as Map<String, dynamic>).toList() ?? [];
          _filterAndSortPatients();
          _isLoading = false;
        });
      } else {
        setState(() {
          _errorMessage =
              response.data['message'] ?? 'Failed to fetch patients';
          _isLoading = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _errorMessage = 'Error: ${e.toString()}';
        _isLoading = false;
      });
    }
  }

  void _filterAndSortPatients() {
    List<Map<String, dynamic>> filtered = List.from(_allPatients);

    final query = _searchController.text.toLowerCase();
    if (query.isNotEmpty) {
      filtered = filtered.where((patient) {
        final name = '${patient['first_name']} ${patient['last_name'] ?? ''}'
            .toLowerCase();
        final phone = (patient['phone'] ?? '').toString().toLowerCase();
        return name.contains(query) || phone.contains(query);
      }).toList();
    }

    if (_currentFilter != PatientFilter.all) {
      filtered = filtered.where((patient) {
        final isAdmitted = _isPatientAdmitted(patient);
        return _currentFilter == PatientFilter.admitted
            ? isAdmitted
            : !isAdmitted;
      }).toList();
    }

    filtered.sort((a, b) {
      switch (_currentSort) {
        case SortOption.nameAsc:
          return '${a['first_name']} ${a['last_name'] ?? ''}'.compareTo(
            '${b['first_name']} ${b['last_name'] ?? ''}',
          );
        case SortOption.nameDesc:
          return '${b['first_name']} ${b['last_name'] ?? ''}'.compareTo(
            '${a['first_name']} ${a['last_name'] ?? ''}',
          );
        case SortOption.newest:
          return DateTime.parse(
            b['admitted_at'] ?? DateTime.now().toString(),
          ).compareTo(
            DateTime.parse(a['admitted_at'] ?? DateTime.now().toString()),
          );
        case SortOption.oldest:
          return DateTime.parse(
            a['admitted_at'] ?? DateTime.now().toString(),
          ).compareTo(
            DateTime.parse(b['admitted_at'] ?? DateTime.now().toString()),
          );
      }
    });

    setState(() => _filteredPatients = filtered);
  }

  bool _isPatientAdmitted(Map<String, dynamic> patient) {
    final dischargedAt = patient['discharged_at'];
    return dischargedAt == null || dischargedAt.toString().isEmpty;
  }

  void _navigateToPatientDetails(Map<String, dynamic> patient) async {
    await Navigator.push(
      context,
      MaterialPageRoute(builder: (_) => PatientDetailsScreen(patient: patient)),
    );
    _fetchPatients();
  }

  void _navigateToAddPatient() async {
    final result = await Navigator.push(
      context,
      MaterialPageRoute(builder: (_) => const PatientFormScreen()),
    );

    if (result != null) {
      _fetchPatients();
    }
  }

  Future<void> _openCamera() async {
    try {
      final cameras = await availableCameras();
      if (!mounted) return;

      Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => CameraScreen(cameras: cameras, from: "Home"),
        ),
      );
    } catch (e) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Could not open camera')));
    }
  }

  String _formatDate(String? dateStr) {
    if (dateStr == null) return 'N/A';
    try {
      final date = DateTime.parse(dateStr).toLocal();
      return DateFormat('MMM dd, yyyy').format(date);
    } catch (e) {
      return dateStr;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Patients'),
            if (!_isLoading)
              Text(
                '${_filteredPatients.length} patient${_filteredPatients.length != 1 ? 's' : ''}',
                style: const TextStyle(fontSize: 12),
              ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.camera_alt_outlined),
            tooltip: 'Open Camera',
            onPressed: _openCamera,
          ),
          PopupMenuButton<SortOption>(
            icon: const Icon(Icons.sort),
            tooltip: 'Sort',
            onSelected: (sort) {
              setState(() => _currentSort = sort);
              _filterAndSortPatients();
            },
            itemBuilder: (context) => [
              const PopupMenuItem(
                value: SortOption.nameAsc,
                child: Row(
                  children: [
                    Icon(Icons.sort_by_alpha),
                    SizedBox(width: 8),
                    Text('Name (A-Z)'),
                  ],
                ),
              ),
              const PopupMenuItem(
                value: SortOption.nameDesc,
                child: Row(
                  children: [
                    Icon(Icons.sort_by_alpha),
                    SizedBox(width: 8),
                    Text('Name (Z-A)'),
                  ],
                ),
              ),
              const PopupMenuItem(
                value: SortOption.newest,
                child: Row(
                  children: [
                    Icon(Icons.arrow_downward),
                    SizedBox(width: 8),
                    Text('Newest First'),
                  ],
                ),
              ),
              const PopupMenuItem(
                value: SortOption.oldest,
                child: Row(
                  children: [
                    Icon(Icons.arrow_upward),
                    SizedBox(width: 8),
                    Text('Oldest First'),
                  ],
                ),
              ),
            ],
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await AuthService().logout();
              if (context.mounted) {
                Navigator.of(context).pushReplacement(
                  MaterialPageRoute(builder: (_) => const LoginScreen()),
                );
              }
            },
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: TextField(
              controller: _searchController,
              decoration: InputDecoration(
                hintText: 'Search by name',
                prefixIcon: const Icon(Icons.search),
                suffixIcon: _searchController.text.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _searchController.clear();
                        },
                      )
                    : null,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(30),
                ),
                filled: true,
                fillColor: Colors.grey.shade100,
              ),
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                FilterChip(
                  label: const Text('All'),
                  selected: _currentFilter == PatientFilter.all,
                  onSelected: (selected) {
                    setState(() => _currentFilter = PatientFilter.all);
                    _filterAndSortPatients();
                  },
                ),
                const SizedBox(width: 8),
                FilterChip(
                  label: const Text('Admitted'),
                  selected: _currentFilter == PatientFilter.admitted,
                  onSelected: (selected) {
                    setState(() => _currentFilter = PatientFilter.admitted);
                    _filterAndSortPatients();
                  },
                ),
                const SizedBox(width: 8),
                FilterChip(
                  label: const Text('Discharged'),
                  selected: _currentFilter == PatientFilter.discharged,
                  onSelected: (selected) {
                    setState(() => _currentFilter = PatientFilter.discharged);
                    _filterAndSortPatients();
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Expanded(child: _buildBody()),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _navigateToAddPatient,
        icon: const Icon(Icons.person_add),
        label: const Text('Add Patient'),
      ),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const LoadingSkeleton();
    }

    if (_errorMessage != null) {
      return EmptyStateWidget(
        icon: Icons.error_outline,
        title: 'Error Loading Patients',
        subtitle: "",
        action: ElevatedButton.icon(
          onPressed: _fetchPatients,
          icon: const Icon(Icons.refresh),
          label: const Text('Retry'),
        ),
      );
    }

    if (_filteredPatients.isEmpty) {
      Widget emptyWidget;
      if (_searchController.text.isNotEmpty ||
          _currentFilter != PatientFilter.all) {
        emptyWidget = EmptyStateWidget(
          icon: Icons.search_off,
          title: 'No Patients Found',
          subtitle: 'Try adjusting your search or filters',
          action: TextButton.icon(
            onPressed: () {
              _searchController.clear();
              setState(() => _currentFilter = PatientFilter.all);
              _filterAndSortPatients();
            },
            icon: const Icon(Icons.clear_all),
            label: const Text('Clear Filters'),
          ),
        );
      } else {
        emptyWidget = const EmptyStateWidget(
          icon: Icons.people_outline,
          title: 'No Patients Yet',
          subtitle: 'Tap the button below to add your first patient',
        );
      }

      return RefreshIndicator(
        onRefresh: _fetchPatients,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [SliverFillRemaining(child: emptyWidget)],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetchPatients,
      child: ListView.builder(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(8),
        itemCount: _filteredPatients.length,
        itemBuilder: (context, index) {
          final patient = _filteredPatients[index];
          final fullName =
              '${patient['first_name']} ${patient['last_name'] ?? ''}'.trim();
          final isAdmitted = _isPatientAdmitted(patient);

          return Card(
            margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
            child: ListTile(
              leading: Stack(
                children: [
                  CircleAvatar(
                    backgroundColor: Colors.blue.shade100,
                    child: Text(
                      fullName.isNotEmpty ? fullName[0].toUpperCase() : '?',
                      style: TextStyle(
                        color: Colors.blue.shade700,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ),
                  Positioned(
                    right: 0,
                    bottom: 0,
                    child: Container(
                      width: 12,
                      height: 12,
                      decoration: BoxDecoration(
                        color: isAdmitted ? Colors.green : Colors.grey,
                        shape: BoxShape.circle,
                        border: Border.all(color: Colors.white, width: 2),
                      ),
                    ),
                  ),
                ],
              ),
              title: Text(
                fullName,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              subtitle: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        Icons.calendar_today,
                        size: 14,
                        color: Colors.grey.shade600,
                      ),
                      const SizedBox(width: 4),
                      Text('Admitted: ${_formatDate(patient['admitted_at'])}'),
                    ],
                  ),
                ],
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => _navigateToPatientDetails(patient),
            ),
          );
        },
      ),
    );
  }
}
