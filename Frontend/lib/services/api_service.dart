import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hospital_app/env/env.dart';

class ApiService {
  static final String baseUrl = Env.key;

  final Dio _dio;
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  ApiService()
    : _dio = Dio(
        BaseOptions(
          baseUrl: baseUrl,
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10),
          headers: {'Content-Type': 'application/json'},
        ),
      ) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          final token = await _storage.read(key: 'accessToken');
          if (token != null) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          return handler.next(options);
        },
        onError: (error, handler) async {
          if (error.response?.statusCode == 401) {
            final success = await _refreshToken();

            if (success) {
              final newToken = await _storage.read(key: 'accessToken');
              error.requestOptions.headers['Authorization'] =
                  'Bearer $newToken';
              final clonedRequest = await _dio.request(
                error.requestOptions.path,
                options: Options(
                  method: error.requestOptions.method,
                  headers: error.requestOptions.headers,
                ),
                data: error.requestOptions.data,
                queryParameters: error.requestOptions.queryParameters,
              );

              return handler.resolve(clonedRequest);
            }
          }
          return handler.next(error);
        },
      ),
    );
  }

  Future<bool> _refreshToken() async {
    try {
      final refreshToken = await _storage.read(key: 'refreshToken');

      final response = await _dio.post(
        '$baseUrl/auth/refreshAccessToken',
        data: {'refreshToken': refreshToken},
      );

      if (response.statusCode == 200) {
        final newAccessToken = response.data['data']['accessToken'];
        final newRefreshToken = response.data['data']['refreshToken'];

        await _storage.write(key: 'accessToken', value: newAccessToken);
        await _storage.write(key: 'refreshToken', value: newRefreshToken);
        return true;
      }
    } catch (e) {
      await _storage.deleteAll();
    }
    return false;
  }

  Future<Response> post(String path, {Map<String, dynamic>? data}) async {
    try {
      return await _dio.post(path, data: data);
    } catch (e) {
      rethrow;
    }
  }

  Future<Response> get(
    String path, {
    Map<String, dynamic>? queryParameters,
  }) async {
    try {
      return await _dio.get(path, queryParameters: queryParameters);
    } catch (e) {
      rethrow;
    }
  }

  Future<Response> patch(String path, {Map<String, dynamic>? data}) async {
    try {
      return await _dio.patch(path, data: data);
    } catch (e) {
      rethrow;
    }
  }

  Future<Response> delete(String path) async {
    try {
      return await _dio.delete(path);
    } catch (e) {
      rethrow;
    }
  }

  Future<Response> deleteWithBody(
    String path, {
    Map<String, dynamic>? data,
  }) async {
    try {
      return await _dio.delete(path, data: data);
    } catch (e) {
      rethrow;
    }
  }

  // Get photos for a patient
  Future<List<dynamic>> getPatientPhotos(String patientId) async {
    try {
      final response = await _dio.get('/uploads/dishargePhotos/$patientId/all');
      if (response.statusCode == 200) {
        return response.data['data'] as List<dynamic>;
      }
      return [];
    } catch (e) {
      rethrow;
    }
  }

  // Get Discharge photos for a patient
  Future<List<dynamic>> getDischargePhotos(
    String patientId,
    String category,
  ) async {
    try {
      final response = await _dio.get(
        '/uploads/dishargePhotos/$patientId/$category',
      );
      if (response.statusCode == 200) {
        return response.data['data'] as List<dynamic>;
      }
      return [];
    } catch (e) {
      rethrow;
    }
  }

  // Delete a photo
  Future<bool> deletePhoto(
    String fileId,
    String patientId,
    String folderId,
  ) async {
    try {
      final response = await _dio.delete(
        '/uploads/$fileId',
        data: {'patientId': patientId, 'folderId': folderId},
      );
      return response.statusCode == 200;
    } catch (e) {
      rethrow;
    }
  }
}
