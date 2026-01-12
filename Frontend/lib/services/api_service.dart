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
        onError: (error, handler) {
          return handler.next(error);
        },
      ),
    );
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
      print('Error fetching photos: $e');
      rethrow;
    }
  }

  // Delete a photo
  Future<bool> deletePhoto(String fileId, String folderId) async {
    try {
      final response = await _dio.delete(
        '/uploads/$fileId',
        data: {'folderId': folderId},
      );
      return response.statusCode == 200;
    } catch (e) {
      rethrow;
    }
  }
}
