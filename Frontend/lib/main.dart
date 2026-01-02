import "package:flutter/material.dart";
import './screens/gallery.screen.dart';
import './screens/login.screen.dart';
import './services/auth_service.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: const AuthCheck(),
      debugShowCheckedModeBanner: false,
      theme: ThemeData.light(),
      darkTheme: ThemeData.dark(),
      themeMode: ThemeMode.system,
    );
  }
}

class AuthCheck extends StatefulWidget {
  const AuthCheck({super.key});

  @override
  State<AuthCheck> createState() => _AuthCheckState();
}

class _AuthCheckState extends State<AuthCheck> {
  final AuthService _authService = AuthService();
  bool _isChecking = true;
  bool _isLoggedIn = false;

  @override
  void initState() {
    super.initState();
    _checkLoginStatus();
  }

  Future<void> _checkLoginStatus() async {
    final loggedIn = await _authService.isLoggedIn();
    if (mounted) {
      setState(() {
        _isLoggedIn = loggedIn;
        _isChecking = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isChecking) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    return _isLoggedIn ? const MainGalleryScreen() : const LoginScreen();
  }
}
