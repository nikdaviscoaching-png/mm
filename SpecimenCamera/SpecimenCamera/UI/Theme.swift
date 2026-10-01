import SwiftUI

enum Theme {
    static let accent = Color(red: 1.0, green: 0.78, blue: 0.2)         // amber, readable on black
    static let panel = Color(white: 0.09)
    static let chip = Color(white: 0.16)
    static let chipSelected = Color(red: 1.0, green: 0.78, blue: 0.2)
    static let danger = Color(red: 1.0, green: 0.3, blue: 0.3)
    static let ok = Color(red: 0.4, green: 0.9, blue: 0.5)
}

struct ChipStyle: ButtonStyle {
    var selected = false
    var tint: Color = Theme.chip
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold, design: .monospaced))
            .padding(.horizontal, 10).frame(minWidth: 44, minHeight: 40)     // large touch targets
            .background(selected ? Theme.chipSelected : tint)
            .foregroundColor(selected ? .black : .white)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct ActionStyle: ButtonStyle {
    var color: Color = Theme.accent
    var prominent = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .bold))
            .padding(.horizontal, 14).frame(minHeight: 44)
            .background(prominent ? color : Color.clear)
            .foregroundColor(prominent ? .black : color)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(color, lineWidth: prominent ? 0 : 1.5))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct ValueLabel: View {
    let title: String
    let value: String
    var highlight = false
    var body: some View {
        VStack(spacing: 1) {
            Text(title).font(.system(size: 9, weight: .semibold)).foregroundColor(.gray)
            Text(value).font(.system(size: 13, weight: .bold, design: .monospaced)).foregroundColor(highlight ? Theme.accent : .white).lineLimit(1).minimumScaleFactor(0.6)
        }
    }
}
