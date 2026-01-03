import 'package:flutter/material.dart';

class LoadingSkeleton extends StatefulWidget {
  final int itemCount;

  const LoadingSkeleton({this.itemCount = 5, super.key});

  @override
  State<LoadingSkeleton> createState() => _LoadingSkeletonState();
}

class _LoadingSkeletonState extends State<LoadingSkeleton>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _animation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 1500),
      vsync: this,
    )..repeat(reverse: true);
    _animation = Tween<double>(begin: 0.3, end: 0.7).animate(_controller);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      padding: const EdgeInsets.all(8),
      itemCount: widget.itemCount,
      itemBuilder: (context, index) {
        return Card(
          margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
          child: Padding(
            padding: const EdgeInsets.all(16.0),
            child: Row(
              children: [
                AnimatedBuilder(
                  animation: _animation,
                  builder: (context, child) {
                    return Container(
                      width: 48,
                      height: 48,
                      decoration: BoxDecoration(
                        color: Colors.grey.withOpacity(_animation.value),
                        shape: BoxShape.circle,
                      ),
                    );
                  },
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      AnimatedBuilder(
                        animation: _animation,
                        builder: (context, child) {
                          return Container(
                            height: 16,
                            width: double.infinity,
                            decoration: BoxDecoration(
                              color: Colors.grey.withOpacity(_animation.value),
                              borderRadius: BorderRadius.circular(4),
                            ),
                          );
                        },
                      ),
                      const SizedBox(height: 8),
                      AnimatedBuilder(
                        animation: _animation,
                        builder: (context, child) {
                          return Container(
                            height: 14,
                            width: 150,
                            decoration: BoxDecoration(
                              color: Colors.grey.withOpacity(_animation.value),
                              borderRadius: BorderRadius.circular(4),
                            ),
                          );
                        },
                      ),
                      const SizedBox(height: 4),
                      AnimatedBuilder(
                        animation: _animation,
                        builder: (context, child) {
                          return Container(
                            height: 14,
                            width: 120,
                            decoration: BoxDecoration(
                              color: Colors.grey.withOpacity(_animation.value),
                              borderRadius: BorderRadius.circular(4),
                            ),
                          );
                        },
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
