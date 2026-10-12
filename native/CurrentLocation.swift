import AppKit
import CoreLocation

final class CurrentLocation: NSObject, CLLocationManagerDelegate {
    let manager = CLLocationManager(), geocoder = CLGeocoder()
    var changed: (([String: Any]) -> Void)?
    var status: ((String) -> Void)?
    var requested = false, busy = false
    var timeout: Timer?
    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }
    func request() {
        requested = true
        if manager.authorizationStatus == .notDetermined {
            status?("location-permission")
            NSApplication.shared.activate(ignoringOtherApps: true)
            manager.requestWhenInUseAuthorization()
        } else {
            authorized()
        }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if requested { authorized() }
    }
    func authorized() {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            guard !busy else { return }
            busy = true
            status?("locating")
            manager.requestLocation()
            timeout?.invalidate()
            timeout = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { [weak self] _ in
                self?.busy = false
                self?.status?("location-unavailable")
            }
        case .denied, .restricted:
            busy = false
            timeout?.invalidate()
            manager.stopUpdatingLocation()
            geocoder.cancelGeocode()
            status?("location-denied")
        case .notDetermined: status?("location-permission")
        @unknown default: status?("location-unavailable")
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy >= 0,
            abs(location.timestamp.timeIntervalSinceNow) < 900
        else { return }
        busy = false
        timeout?.invalidate()
        // Weather needs city-scale coordinates; don't persist a precise location.
        let lat = (location.coordinate.latitude * 100).rounded() / 100
        let lon = (location.coordinate.longitude * 100).rounded() / 100
        geocoder.cancelGeocode()
        geocoder.reverseGeocodeLocation(location) { [weak self] places, _ in
            let place = places?.first
            let name = place?.locality ?? place?.administrativeArea ?? "Current location"
            DispatchQueue.main.async {
                guard let self = self, self.manager.authorizationStatus == .authorizedAlways else {
                    return
                }
                self.changed?(["name": name, "latitude": lat, "longitude": lon])
            }
        }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        busy = false
        timeout?.invalidate()
        status?("location-unavailable")
    }
    func stop() {
        timeout?.invalidate()
        geocoder.cancelGeocode()
        manager.stopUpdatingLocation()
    }
}
