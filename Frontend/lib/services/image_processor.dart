import 'dart:io';
import 'package:image/image.dart' as img;
import 'package:flutter/foundation.dart';

class ImageProcessor {
  static Future<void> stampImage(Map<String, dynamic> data) async {
    final File imageFile = File(data['path']);
    final bytes = await imageFile.readAsBytes();

    img.Image? baseImage = img.decodeImage(bytes);
    if (baseImage == null) return;

    const int logicalWidth = 1100;

    var titleFont = img.arial48;
    var detailFont = img.arial24;
    var white = img.ColorRgba8(255, 255, 255, 255);

    const int outerPad = 30;
    const int mapSize = 250;
    const int gap = 20;
    const int textInnerPad = 20;

    int textBoxX = outerPad + mapSize + gap;
    int maxTextWidth = logicalWidth - textBoxX - outerPad - (textInnerPad * 2);

    String titleText = data['title'] ?? "";

    List<String> wrapText(String text, int maxWidth, int charWidth) {
      List<String> lines = [];
      int maxCharsPerLine = maxWidth ~/ charWidth;
      List<String> words = text.split(' ');
      String currentLine = "";
      for (var word in words) {
        if ((currentLine.length + word.length + 1) > maxCharsPerLine) {
          if (currentLine.isNotEmpty) lines.add(currentLine);
          currentLine = word;
        } else {
          currentLine = (currentLine.isEmpty) ? word : "$currentLine $word";
        }
      }
      if (currentLine.isNotEmpty) lines.add(currentLine);
      return lines;
    }

    List<String> titleLines = wrapText(titleText, maxTextWidth, 20);
    if (titleLines.length > 2) titleLines = titleLines.sublist(0, 2);

    List<String> addressLines = wrapText(
      data['address'] ?? "",
      maxTextWidth,
      10,
    );
    if (addressLines.length > 2) addressLines = addressLines.sublist(0, 2);

    int lineSpacing = 10;

    int titleBlockH =
        (titleLines.length * 48) +
        ((titleLines.isNotEmpty ? titleLines.length - 1 : 0) * lineSpacing);

    int addrBlockH =
        (addressLines.length * 24) +
        ((addressLines.isNotEmpty ? addressLines.length - 1 : 0) * lineSpacing);

    int coordsH = 24;
    int timeH = 24;

    int textContentHeight =
        titleBlockH +
        lineSpacing +
        addrBlockH +
        lineSpacing +
        coordsH +
        lineSpacing +
        timeH;
    int textBoxHeight = textContentHeight + (textInnerPad * 2);

    int layerHeight = (mapSize > textBoxHeight) ? mapSize : textBoxHeight;
    layerHeight += outerPad;

    img.Image overlayLayer = img.Image(
      width: logicalWidth,
      height: layerHeight,
      numChannels: 4,
    );

    int boxBottomY = layerHeight - outerPad;
    int boxTopY = boxBottomY - textBoxHeight;

    img.fillRect(
      overlayLayer,
      x1: textBoxX,
      y1: boxTopY,
      x2: logicalWidth - outerPad,
      y2: boxBottomY,
      color: img.ColorRgba8(0, 0, 0, 170),
      radius: 15,
    );

    int currentY = boxTopY + textInnerPad;
    int textX = textBoxX + textInnerPad;

    void drawBoldString(String text, int x, int y, img.BitmapFont font) {
      img.drawString(
        overlayLayer,
        text,
        font: font,
        x: x + 1,
        y: y,
        color: white,
      );
      img.drawString(overlayLayer, text, font: font, x: x, y: y, color: white);
    }

    for (String line in titleLines) {
      drawBoldString(line, textX, currentY, titleFont);
      currentY += 48 + lineSpacing;
    }

    for (String line in addressLines) {
      img.drawString(
        overlayLayer,
        line,
        font: detailFont,
        x: textX,
        y: currentY,
        color: white,
      );
      currentY += 24 + lineSpacing;
    }

    img.drawString(
      overlayLayer,
      data['coords'],
      font: detailFont,
      x: textX,
      y: currentY,
      color: white,
    );
    currentY += 24 + lineSpacing;

    img.drawString(
      overlayLayer,
      data['time'],
      font: detailFont,
      x: textX,
      y: currentY,
      color: white,
    );

    int mapTopY = boxBottomY - mapSize;

    try {
      if (data['mapBytes'] != null) {
        Uint8List mapBytes = data['mapBytes'];
        img.Image? mapImg = img.decodeImage(mapBytes);

        if (mapImg != null) {
          img.Image croppedMap = img.copyCrop(
            mapImg,
            x: 0,
            y: 0,
            width: mapImg.width,
            height: (mapImg.height * 0.82).toInt(),
          );

          img.Image resizedMap = img.copyResize(
            croppedMap,
            width: mapSize,
            height: mapSize,
            interpolation: img.Interpolation.linear,
          );

          img.compositeImage(
            overlayLayer,
            resizedMap,
            dstX: outerPad,
            dstY: mapTopY,
          );
        }
      }
    } catch (e) {
      debugPrint("Map decode failed: $e");
    }

    img.Image finalOverlay = img.copyResize(
      overlayLayer,
      width: baseImage.width,
      interpolation: img.Interpolation.linear,
    );

    img.compositeImage(
      baseImage,
      finalOverlay,
      dstX: 0,
      dstY: baseImage.height - finalOverlay.height,
    );

    await imageFile.writeAsBytes(img.encodeJpg(baseImage, quality: 95));
  }
}
