#import "NightShift.h"
#import <objc/runtime.h>
#import <dlfcn.h>

// Read-only, optional CoreBrightness client. Never change the Mac's display settings.
static id client;
static void *framework;
NSDictionary *SideThingNightShiftRead(void) {
    if (!client) return @{ @"supported": @NO, @"enabled": @NO, @"strength": @0 };
    SEL statusSelector = NSSelectorFromString(@"getBlueLightStatus:");
    SEL strengthSelector = NSSelectorFromString(@"getStrength:");
    // The stable status ABI begins with active/enabled BOOLs. Reserve enough space for
    // later fields rather than coupling the app to a private schedule structure.
    unsigned char status[256] = {0};
    float strength = 0;
    BOOL (*getStatus)(id, SEL, void *) = (void *)[client methodForSelector:statusSelector];
    BOOL (*getStrength)(id, SEL, float *) = (void *)[client methodForSelector:strengthSelector];
    BOOL valid = getStatus(client, statusSelector, status) && getStrength(client, strengthSelector, &strength);
    if (!valid || !isfinite(strength)) return @{ @"supported": @NO, @"enabled": @NO, @"strength": @0 };
    return @{ @"supported": @YES, @"enabled": @(status[0] && status[1]), @"strength": @(fminf(1, fmaxf(0, strength))) };
}
void SideThingNightShiftStart(void (^changed)(void)) {
    framework = dlopen("/System/Library/PrivateFrameworks/CoreBrightness.framework/CoreBrightness", RTLD_LAZY | RTLD_LOCAL);
    Class type = NSClassFromString(@"CBBlueLightClient");
    if (!type) return;
    client = [[type alloc] init];
    for (NSString *name in @[@"getBlueLightStatus:", @"getStrength:", @"setStatusNotificationBlock:"])
        if (![client respondsToSelector:NSSelectorFromString(name)]) { client = nil; return; }
    // A method exposing a larger/new status structure must not write past our buffer.
    Method method = class_getInstanceMethod(type, NSSelectorFromString(@"getBlueLightStatus:"));
    char argument[1024] = {0};
    method_getArgumentType(method, 2, argument, sizeof(argument));
    NSUInteger size = 0;
    if (argument[0] != '^' || !NSGetSizeAndAlignment(argument + 1, &size, NULL) || size > 256) { client = nil; return; }
    void (^notify)(void) = ^{ dispatch_async(dispatch_get_main_queue(), changed); };
    void (*registerBlock)(id, SEL, id) = (void *)[client methodForSelector:NSSelectorFromString(@"setStatusNotificationBlock:")];
    registerBlock(client, NSSelectorFromString(@"setStatusNotificationBlock:"), notify);
}
void SideThingNightShiftStop(void) {
    if (client) {
        SEL selector = NSSelectorFromString(@"setStatusNotificationBlock:");
        void (*registerBlock)(id, SEL, id) = (void *)[client methodForSelector:selector];
        registerBlock(client, selector, nil);
    }
    client = nil;
    // Keep the optional framework loaded: pending system callbacks may still refer to it.
}
