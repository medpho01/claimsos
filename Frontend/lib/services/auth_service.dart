import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'api_service.dart';

class AuthService {
  final ApiService _api = ApiService();
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  Future<Map<String, dynamic>> login(String username, String password) async {
    try {
      final response = await _api.post(
        '/v1/auth/login',
        data: {'userName': username, 'passWord': password},
      );

      if (response.statusCode == 200) {
        final data = response.data['data'];

        // Store tokens securely
        await _storage.write(key: 'accessToken', value: data['accessToken']);
        await _storage.write(key: 'refreshToken', value: data['refreshToken']);

        // Store user info
        await _storage.write(key: 'userId', value: data['user']['id']);
        await _storage.write(key: 'username', value: data['user']['username']);
        await _storage.write(key: 'role', value: data['user']['role']);

        return {'success': true, 'user': data['user']};
      } else {
        return {
          'success': false,
          'message': response.data['message'] ?? 'Login failed',
        };
      }
    } catch (e) {
      return {'success': false, 'message': 'Connection error: ${e.toString()}'};
    }
  }

  Future<void> logout() async {
    await _storage.deleteAll();
  }

  Future<bool> isLoggedIn() async {
    final token = await _storage.read(key: 'accessToken');
    return token != null;
  }

  Future<String?> getUsername() async {
    return await _storage.read(key: 'username');
  }
}
