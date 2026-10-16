import Foundation
import Vision
import AppKit

// 애플 Vision 글자 인식 — 기기 안에서 돈다(네트워크·요금 없음).
// 쓰기: swift ocr.swift <그림경로>  →  JSON {w,h,lines:[{t,x,y,w,h,conf}]}
let args = CommandLine.arguments
guard args.count > 1, let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("{\"error\":\"못 읽음\"}"); exit(1)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
req.recognitionLanguages = ["ko-KR", "en-US"]
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
let t0 = Date()
try? handler.perform([req])
let ms = Int(Date().timeIntervalSince(t0) * 1000)
var lines: [String] = []
for ob in (req.results ?? []) {
    guard let top = ob.topCandidates(1).first else { continue }
    let b = ob.boundingBox   // 0~1, 왼쪽 아래 기준
    let t = top.string.replacingOccurrences(of: "\"", with: "\\\"")
    lines.append(String(format: "{\"t\":\"%@\",\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f,\"conf\":%.2f}",
        t, b.minX, 1 - b.maxY, b.width, b.height, top.confidence))
}
print("{\"w\":\(cg.width),\"h\":\(cg.height),\"ms\":\(ms),\"n\":\(lines.count),\"lines\":[\(lines.joined(separator: ","))]}")
