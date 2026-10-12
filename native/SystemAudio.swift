import AudioToolbox
import CoreAudio

// All state changes run on the main queue; audio hardware events replace polling.
enum SystemAudio {
    static var changed: (() -> Void)?
    static var current: [String: Any] = ["volume": NSNull(), "output": NSNull()]
    static var device = AudioDeviceID(0)
    static var inventoryVersion = 0
    static let listener: AudioObjectPropertyListenerBlock = { count, addresses in
        if (0..<Int(count)).contains(where: {
            addresses[$0].mSelector == kAudioHardwarePropertyDevices
        }) {
            inventoryVersion += 1
        }
        refresh()
    }
    static func property(_ selector: AudioObjectPropertySelector, output: Bool = false)
        -> AudioObjectPropertyAddress
    {
        AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: output ? kAudioDevicePropertyScopeOutput : kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
    }
    static func output() -> AudioDeviceID? {
        var address = property(kAudioHardwarePropertyDefaultOutputDevice)
        var value = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        return AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &value) == noErr
            && value != 0 ? value : nil
    }
    static func name(_ id: AudioDeviceID) -> String {
        var address = property(kAudioObjectPropertyName)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr,
            let value = value
        else { return "Audio output" }
        return value.takeRetainedValue() as String
    }
    static func volume(_ id: AudioDeviceID) -> Float32? {
        var address = property(kAudioHardwareServiceDeviceProperty_VirtualMainVolume, output: true)
        var value = Float32(0)
        var size = UInt32(MemoryLayout<Float32>.size)
        var writable: DarwinBoolean = false
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr,
            AudioObjectIsPropertySettable(id, &address, &writable) == noErr, writable.boolValue,
            value.isFinite
        else { return nil }
        return value
    }
    static func refresh() {
        let next = output() ?? 0
        if next != device {
            var address = property(
                kAudioHardwareServiceDeviceProperty_VirtualMainVolume, output: true)
            if device != 0 {
                AudioObjectRemovePropertyListenerBlock(device, &address, .main, listener)
            }
            device = next
            if device != 0 {
                AudioObjectAddPropertyListenerBlock(device, &address, .main, listener)
            }
        }
        current = [
            "outputRevision": inventoryVersion,
            "volume": volume(device).map { Double($0) } ?? NSNull(),
            "output": device == 0 ? NSNull() : ["id": device, "name": name(device)],
        ]
        changed?()
    }
    static func start(_ callback: @escaping () -> Void) {
        changed = callback
        for selector in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices] {
            var address = property(selector)
            AudioObjectAddPropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject), &address, .main, listener)
        }
        refresh()
    }
    static func stop() {
        changed = nil
        for selector in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices] {
            var address = property(selector)
            AudioObjectRemovePropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject), &address, .main, listener)
        }
        var address = property(kAudioHardwareServiceDeviceProperty_VirtualMainVolume, output: true)
        if device != 0 { AudioObjectRemovePropertyListenerBlock(device, &address, .main, listener) }
    }
    static func outputs() -> [[String: Any]] {
        var address = property(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard
            AudioObjectGetPropertyDataSize(
                AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr
        else { return [] }
        guard size > 0 else { return [] }
        var devices = [AudioDeviceID](
            repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        let status = devices.withUnsafeMutableBytes {
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, $0.baseAddress!)
        }
        guard status == noErr else { return [] }
        return devices.filter { id in
            var streams = property(kAudioDevicePropertyStreams, output: true)
            var count: UInt32 = 0
            var aliveProperty = property(kAudioDevicePropertyDeviceIsAlive)
            var alive: UInt32 = 0
            var aliveSize = UInt32(MemoryLayout<UInt32>.size)
            return AudioObjectGetPropertyData(id, &aliveProperty, 0, nil, &aliveSize, &alive)
                == noErr && alive != 0
                && AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &count) == noErr
                && count > 0
        }.map { ["id": $0, "name": name($0)] }
    }
    static func select(_ id: AudioDeviceID) -> Bool {
        guard outputs().contains(where: { $0["id"] as? UInt32 == id }) else { return false }
        var address = property(kAudioHardwarePropertyDefaultOutputDevice)
        var value = id
        guard
            AudioObjectSetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address, 0, nil,
                UInt32(MemoryLayout<AudioDeviceID>.size), &value) == noErr
        else { return false }
        refresh()
        return device == id
    }
    static func adjust(_ delta: Float32) -> Float32? {
        guard let id = output(), let previous = volume(id) else { return nil }
        var address = property(kAudioHardwareServiceDeviceProperty_VirtualMainVolume, output: true)
        var value = min(1, max(0, previous + delta))
        guard
            AudioObjectSetPropertyData(
                id, &address, 0, nil, UInt32(MemoryLayout<Float32>.size), &value) == noErr
        else { return nil }
        if value > 0 {
            var mute = property(kAudioDevicePropertyMute, output: true)
            var off = UInt32(0)
            if AudioObjectHasProperty(id, &mute) {
                _ = AudioObjectSetPropertyData(id, &mute, 0, nil, 4, &off)
            }
        }
        refresh()
        return volume(id)
    }
}
