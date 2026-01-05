import 'dart:async';
import 'package:flutter/material.dart';
import 'package:camera/camera.dart';
import 'package:geolocator/geolocator.dart';
import 'package:geocoding/geocoding.dart';
import 'package:gal/gal.dart';
import 'package:flutter/foundation.dart';
import 'package:intl/intl.dart';
import 'package:http/http.dart' as http;
import 'package:photo_manager/photo_manager.dart';
import 'package:photo_manager_image_provider/photo_manager_image_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import '../services/location_service.dart';
import '../services/image_processor.dart';
import './gallery.screen.dart';

class CameraScreen extends StatefulWidget {
  final List<CameraDescription> cameras;
  final String from;

  const CameraScreen({super.key, required this.cameras, required this.from});

  @override
  State<CameraScreen> createState() => _CameraScreenState();
}

class _CameraScreenState extends State<CameraScreen>
    with WidgetsBindingObserver {
  CameraController? _controller;
  StreamSubscription<Position>? _positionStream;
  int _camIdx = 0;
  double _zoom = 1.0;
  FlashMode _flash = FlashMode.off;
  bool _isGeo = true;

  GeoData? _currentGeo;
  Placemark? _cachedPlacemark;
  Uint8List? _cachedMapBytes;
  GeoData? _lastMapLoc;
  bool _loading = false;
  AssetEntity? _latestImage;
  bool _isPermissionGranted = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _checkPermissionsAndInit();
  }

  Future<void> _checkPermissionsAndInit() async {
    Map<Permission, PermissionStatus> statuses = await [
      Permission.camera,
      Permission.location,
    ].request();

    bool camGranted = statuses[Permission.camera]!.isGranted;
    bool locGranted = statuses[Permission.location]!.isGranted;

    if (camGranted && locGranted) {
      if (mounted) setState(() => _isPermissionGranted = true);
      _initEverything();
      _fetchLatestImage();
    } else {
      if (mounted) setState(() => _isPermissionGranted = false);

      bool camPermanentlyDenied =
          statuses[Permission.camera]!.isPermanentlyDenied;
      bool locPermanentlyDenied =
          statuses[Permission.location]!.isPermanentlyDenied;

      if (camPermanentlyDenied || locPermanentlyDenied) {
        _showOpenSettingsDialog();
      }
    }
  }

  void _showOpenSettingsDialog() {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: const Text("Permissions Required"),
        content: const Text(
          "This app needs Camera and Location access to function.\n\n"
          "You have permanently denied these. Please open settings and enable them manually.",
        ),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.of(context).pop();
            },
            child: const Text("Cancel"),
          ),
          TextButton(
            onPressed: () async {
              Navigator.of(ctx).pop();
              await openAppSettings();
            },
            child: const Text("Open Settings"),
          ),
        ],
      ),
    );
  }

  Future<void> _initEverything() async {
    if (widget.cameras.isNotEmpty) {
      await _initCam(widget.cameras[_camIdx]);
    }
    _startLocationUpdates();
  }

  Future<void> _fetchLatestImage() async {
    final PermissionState ps = await PhotoManager.requestPermissionExtend();
    if (!ps.isAuth) return;

    final List<AssetPathEntity> paths = await PhotoManager.getAssetPathList(
      type: RequestType.image,
      filterOption: FilterOptionGroup(
        orders: [
          const OrderOption(type: OrderOptionType.createDate, asc: false),
        ],
      ),
    );

    if (paths.isEmpty) return;

    final List<AssetEntity> assets = await paths[0].getAssetListRange(
      start: 0,
      end: 1,
    );

    if (assets.isNotEmpty && mounted) {
      setState(() {
        _latestImage = assets.first;
      });
    }
  }

  void _startLocationUpdates() {
    const locationSettings = LocationSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: 5,
    );

    _positionStream =
        Geolocator.getPositionStream(locationSettings: locationSettings).listen(
          (Position position) async {
            final data = await LocationService().getCurrentGeoData();
            if (mounted) {
              setState(() {
                _currentGeo = data;
                _cachedPlacemark = null;
              });
              if (data != null) {
                _smartUpdateMap(data);
              }
            }
          },
        );
  }

  void _smartUpdateMap(GeoData current) {
    bool shouldFetch = false;
    if (_lastMapLoc == null) {
      shouldFetch = true;
    } else {
      double dist = Geolocator.distanceBetween(
        _lastMapLoc!.lat,
        _lastMapLoc!.lon,
        current.lat,
        current.lon,
      );
      if (dist > 100) shouldFetch = true;
    }
    if (shouldFetch) _downloadMapSnapshot(current);
  }

  Future<void> _downloadMapSnapshot(GeoData location) async {
    try {
      final String lon = location.lon.toString();
      final String lat = location.lat.toString();
      final url =
          "https://static-maps.yandex.ru/1.x/?ll=$lon,$lat&z=17&size=350,450&l=sat&pt=$lon,$lat,pm2rdm";
      final response = await http.get(Uri.parse(url));
      if (response.statusCode == 200 && mounted) {
        setState(() {
          _cachedMapBytes = response.bodyBytes;
          _lastMapLoc = location;
        });
      }
    } catch (e) {
      debugPrint("Map download error: $e");
    }
  }

  Future<void> _initCam(CameraDescription desc) async {
    final controller = CameraController(
      desc,
      ResolutionPreset.high,
      enableAudio: false,
      imageFormatGroup: ImageFormatGroup.jpeg,
    );
    try {
      await controller.initialize();
      if (mounted) setState(() => _controller = controller);
    } catch (e) {
      debugPrint("Camera Init Error: $e");
    }
  }

  Future<String> _getAddress(bool isFullAddress) async {
    if (_cachedPlacemark == null) {
      try {
        if (_currentGeo == null) return "Unknown Location";
        List<Placemark> marks = await placemarkFromCoordinates(
          _currentGeo!.lat,
          _currentGeo!.lon,
        );
        if (marks.isNotEmpty) _cachedPlacemark = marks.first;
      } catch (e) {
        return "Unknown Address";
      }
    }
    if (_cachedPlacemark == null) return "Unknown Address";
    Placemark p = _cachedPlacemark!;

    var list = isFullAddress
        ? [
            p.name,
            p.subLocality,
            p.street,
            p.locality,
            p.administrativeArea,
            p.postalCode,
          ]
        : [p.locality, p.administrativeArea, p.country];
    return list
        .where((part) => part != null && part.trim().isNotEmpty)
        .join(", ");
  }

  Widget _buildGeoOverlay() {
    if (_currentGeo == null) return const SizedBox.shrink();

    return FutureBuilder<List<String>>(
      future: Future.wait([_getAddress(false), _getAddress(true)]),
      builder: (context, snapshot) {
        final title = snapshot.data?[0] ?? "";
        final address = snapshot.data?[1] ?? "Locating...";

        return Positioned(
          bottom: 0,
          left: 0,
          right: 0,
          child: Container(
            padding: const EdgeInsets.all(15),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Container(
                  width: 85,
                  height: 85,
                  margin: const EdgeInsets.only(right: 12),
                  decoration: const BoxDecoration(color: Colors.white24),
                  child: ClipRRect(
                    child: _cachedMapBytes != null
                        ? Image.memory(_cachedMapBytes!, fit: BoxFit.cover)
                        : const Center(
                            child: SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          ),
                  ),
                ),
                Expanded(
                  child: Container(
                    decoration: BoxDecoration(
                      color: Colors.black.withOpacity(0.66),
                      borderRadius: const BorderRadius.all(Radius.circular(8)),
                    ),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 5,
                      vertical: 7,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (title.isNotEmpty)
                          Text(
                            title,
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 13,
                              fontWeight: FontWeight.bold,
                            ),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                        const SizedBox(height: 4),
                        Text(
                          address.toUpperCase(),
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 11,
                            height: 1.2,
                          ),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 6),
                        Text(
                          "Lat ${_currentGeo!.lat.toStringAsFixed(6)}° Long ${_currentGeo!.lon.toStringAsFixed(6)}°",
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 10,
                          ),
                        ),
                        Text(
                          "${DateFormat('EEEE, dd/MM/yyyy hh:mm a').format(DateTime.now())} GMT +05:30",
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 10,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _capture() async {
    if (_loading || _controller == null || !_controller!.value.isInitialized) {
      return;
    }
    setState(() => _loading = true);

    try {
      final imgFile = await _controller!.takePicture();
      if (_isGeo && _currentGeo != null) {
        final addr = await _getAddress(true);
        final title = await _getAddress(false);
        final timestamp = DateFormat(
          'EEEE, dd/MM/yyyy hh:mm a',
        ).format(DateTime.now());

        await compute(ImageProcessor.stampImage, {
          'path': imgFile.path,
          'address': addr,
          'title': title,
          'coords':
              "Lat ${_currentGeo!.lat.toStringAsFixed(6)}° Long ${_currentGeo!.lon.toStringAsFixed(6)}°",
          'time': "$timestamp GMT +05:30",
          'mapBytes': _cachedMapBytes,
        });
      }
      await Gal.putImage(imgFile.path);
      await Future.delayed(const Duration(milliseconds: 500));
      await _fetchLatestImage();
    } catch (e) {
      debugPrint("Capture failed: $e");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void dispose() {
    _positionStream?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    _controller?.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      if (!_isPermissionGranted) {
        _checkPermissionsAndInit();
      }
    }
  }

  Widget _buildViewfinder() {
    return ClipRect(
      child: FittedBox(
        fit: BoxFit.cover,
        child: SizedBox(
          width: _controller!.value.previewSize!.height,
          height: _controller!.value.previewSize!.width,
          child: CameraPreview(_controller!),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!_isPermissionGranted) {
      return Scaffold(
        backgroundColor: Colors.black,
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.no_photography, color: Colors.white, size: 50),
              const SizedBox(height: 16),
              const Text(
                "Camera & Location Required",
                style: TextStyle(color: Colors.white, fontSize: 18),
              ),
              const SizedBox(height: 8),
              ElevatedButton(
                onPressed: _checkPermissionsAndInit,
                child: const Text("Grant Permissions"),
              ),
            ],
          ),
        ),
      );
    }

    if (_controller == null || !_controller!.value.isInitialized) {
      return const Scaffold(
        backgroundColor: Colors.black,
        body: Center(child: CircularProgressIndicator()),
      );
    }

    final screenWidth = MediaQuery.of(context).size.width;
    final cameraHeight = screenWidth * 4 / 3;

    return Scaffold(
      backgroundColor: Colors.black,
      body: Column(
        children: [
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  // Modified Left Side: Home + Flash
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      IconButton(
                        icon: const Icon(
                          Icons.home_filled,
                          color: Colors.white,
                          size: 28,
                        ),
                        onPressed: () {
                          Navigator.of(
                            context,
                          ).popUntil((route) => route.isFirst);
                        },
                      ),
                      IconButton(
                        icon: Icon(
                          _flash == FlashMode.off
                              ? Icons.flash_off
                              : Icons.flash_on,
                          color: Colors.yellow,
                        ),
                        onPressed: () async {
                          _flash = _flash == FlashMode.off
                              ? FlashMode.always
                              : FlashMode.off;
                          await _controller?.setFlashMode(_flash);
                          setState(() {});
                        },
                      ),
                    ],
                  ),

                  const Text(
                    "Camera",
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 18,
                      color: Colors.white,
                    ),
                  ),
                  Switch(
                    value: _isGeo,
                    activeThumbColor: Colors.yellow,
                    onChanged: (v) => setState(() => _isGeo = v),
                  ),
                ],
              ),
            ),
          ),
          SizedBox(
            width: screenWidth,
            height: cameraHeight,
            child: Stack(
              children: [
                SizedBox.expand(child: _buildViewfinder()),
                if (_isGeo) _buildGeoOverlay(),
                if (_loading)
                  Container(
                    color: Colors.black45,
                    child: const Center(
                      child: CircularProgressIndicator(color: Colors.yellow),
                    ),
                  ),
              ],
            ),
          ),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [1.0, 2.0]
                      .map(
                        (z) => Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          child: ChoiceChip(
                            label: Text("${z.toInt()}x"),
                            shape: CircleBorder(),
                            showCheckmark: false,
                            selected: _zoom == z,
                            selectedColor: Colors.yellow,
                            labelStyle: TextStyle(
                              color: _zoom == z ? Colors.black : Colors.white,
                            ),
                            onSelected: (_) {
                              setState(() => _zoom = z);
                              _controller?.setZoomLevel(z);
                            },
                          ),
                        ),
                      )
                      .toList(),
                ),
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  children: [
                    GestureDetector(
                      onTap: () {
                        if (widget.from == "Gallery") {
                          Navigator.of(context).pop();
                        } else {
                          Navigator.push(
                            context,
                            MaterialPageRoute(
                              builder: (c) => MainGalleryScreen(),
                            ),
                          );
                        }
                      },
                      child: Container(
                        height: 50,
                        width: 50,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(color: Colors.white, width: 2),
                          color: Colors.black,
                        ),
                        child: _latestImage == null
                            ? const Icon(
                                Icons.photo,
                                color: Colors.white,
                                size: 20,
                              )
                            : ClipOval(
                                child: AssetEntityImage(
                                  _latestImage!,
                                  isOriginal: false,
                                  thumbnailSize: const ThumbnailSize.square(
                                    200,
                                  ),
                                  fit: BoxFit.cover,
                                ),
                              ),
                      ),
                    ),
                    GestureDetector(
                      onTap: _capture,
                      child: Container(
                        height: 85,
                        width: 85,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(color: Colors.white, width: 4),
                        ),
                        child: Center(
                          child: Container(
                            height: 65,
                            width: 65,
                            decoration: const BoxDecoration(
                              color: Colors.white,
                              shape: BoxShape.circle,
                            ),
                          ),
                        ),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(
                        Icons.flip_camera_android,
                        size: 35,
                        color: Colors.white,
                      ),
                      onPressed: () {
                        _camIdx = (_camIdx + 1) % widget.cameras.length;
                        _initCam(widget.cameras[_camIdx]);
                      },
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
