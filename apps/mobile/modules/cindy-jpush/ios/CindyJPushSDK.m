#import "CindyJPushSDK.h"
#import <JPUSHService.h>

@implementation CindyJPushSDK
+ (void)start:(NSString *)appKey production:(BOOL)production {
  static BOOL started = NO;
  if (!started) {
    // Cindy only needs APNs alias delivery; turn the SDK's optional collectors and
    // features off before setup so they do no background work.
    JPushCollectControl *collect = [[JPushCollectControl alloc] init];
    collect.ssid = NO;
    collect.bssid = NO;
    collect.cell = NO;
    collect.gps = NO;
    [JPUSHService setCollectControl:collect];
    [JPUSHService setLocationEanable:NO];
    [JPUSHService setSmartPushEnable:NO];
    [JPUSHService setBackgroundEnable:NO];
    [JPUSHService setDataInsightsEnable:NO];
    [JPUSHService setupWithOption:nil appKey:appKey channel:@"personal" apsForProduction:production];
    // The header requires log level changes after setup.
    [JPUSHService setLogOFF];
    started = YES;
  }
  [JPUSHService turnOnPush];
}
+ (void)registerToken:(NSData *)token { [JPUSHService registerDeviceToken:token]; }
+ (void)bindAlias:(NSString *)alias completion:(void (^)(NSInteger))completion {
  [JPUSHService setAlias:alias completion:^(NSInteger code, NSString *value, NSInteger seq) {
    completion(code);
  } seq:1];
}
+ (void)disable:(void (^)(NSInteger))completion {
  [JPUSHService deleteAlias:^(NSInteger code, NSString *value, NSInteger seq) {
    // Token unbinding also pauses SDK connections; both errors remain retryable.
    [JPUSHService turnOffPush:^(NSInteger offCode) { completion(code != 0 ? code : offCode); }];
  } seq:2];
}
@end
