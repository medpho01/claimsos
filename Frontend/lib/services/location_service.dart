import 'package:geolocator/geolocator.dart';
import 'package:geocoding/geocoding.dart';

class GeoData {
  final double lat;
  final double lon;
  final String address;
  GeoData({required this.lat, required this.lon, required this.address});
}

class LocationService {
  Future<GeoData?> getCurrentGeoData() async {
    // 1. Check Permissions
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) return null;
    }

    if (permission == LocationPermission.deniedForever) return null;

    // 2. Get Position
    Position pos = await Geolocator.getCurrentPosition(
      // ignore: deprecated_member_use
      desiredAccuracy: LocationAccuracy.high,
    );

    // 3. Get Address
    try {
      List<Placemark> marks = await placemarkFromCoordinates(
        pos.latitude,
        pos.longitude,
      );
      String addr = "Unknown Address";
      if (marks.isNotEmpty) {
        Placemark p = marks.first;
        addr =
            "${p.name}, ${p.subLocality}, ${p.street}, ${p.locality}, ${p.administrativeArea} ${p.postalCode}, ${p.country}";
      }
      return GeoData(lat: pos.latitude, lon: pos.longitude, address: addr);
    } catch (e) {
      return GeoData(
        lat: pos.latitude,
        lon: pos.longitude,
        address: "Address not found",
      );
    }
  }
}
