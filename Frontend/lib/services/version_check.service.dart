import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:pub_semver/pub_semver.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:http/http.dart' as http;
import '../env/env.dart';

class VersionCheckService {
  Future<String> _fetchMinVersionFromApi() async {
    try {
      final url = "${Env.key}/version";
      final response = await http.get(Uri.parse(url));
      if (response.statusCode == 200) {
        final data = await json.decode(response.body);
        return data["version"] ?? "1.0.0";
      }
    } catch (e) {
      return "1.0.0";
    }
    return "1.0.0";
  }

  Future<void> checkVersion(BuildContext context) async {
    try {
      final PackageInfo info = await PackageInfo.fromPlatform();
      final Version currentVersion = Version.parse(info.version);

      final String minVersionString = await _fetchMinVersionFromApi();
      final Version minVersion = Version.parse(minVersionString);

      if (currentVersion < minVersion) {
        if (context.mounted) {
          _showForceUpdateDialog(context, minVersionString);
        }
      }
    } catch (e) {
      debugPrint("Version check failed: $e");
    }
  }

  void _showForceUpdateDialog(BuildContext context, String requiredVersion) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) {
        return PopScope(
          canPop: false,
          child: AlertDialog(
            title: const Text("Update Required"),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(15),
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.system_update, size: 60, color: Colors.orange),
                const SizedBox(height: 16),
                Text(
                  "A new version ($requiredVersion) is available. Please update to continue using the app.",
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 16),
                ),
              ],
            ),
            actions: [
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.green,
                  foregroundColor: Colors.white,
                  minimumSize: const Size(double.infinity, 45),
                ),
                onPressed: _launchStore,
                child: const Text("Update Now"),
              ),
            ],
          ),
        );
      },
    );
  }

  Future<void> _launchStore() async {
    const String androidPackageName = 'com.twentyfoureleven.claims';
    const String iOSAppId = '123456789';

    final Uri url = Platform.isAndroid
        ? Uri.parse("market://details?id=$androidPackageName")
        : Uri.parse("https://apps.apple.com/app/id$iOSAppId");

    if (await canLaunchUrl(url)) {
      await launchUrl(url, mode: LaunchMode.externalApplication);
    } else {
      final Uri webUrl = Platform.isAndroid
          ? Uri.parse(
              "https://play.google.com/store/apps/details?id=$androidPackageName",
            )
          : Uri.parse("https://apps.apple.com/app/id$iOSAppId");

      if (await canLaunchUrl(webUrl)) {
        await launchUrl(webUrl, mode: LaunchMode.externalApplication);
      }
    }
  }
}
