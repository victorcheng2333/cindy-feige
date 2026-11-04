#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
@interface CindyJPushSDK : NSObject
+ (void)start:(NSString *)appKey production:(BOOL)production;
+ (void)registerToken:(NSData *)token;
+ (void)bindAlias:(NSString *)alias completion:(void (^)(NSInteger))completion;
+ (void)disable:(void (^)(NSInteger))completion;
@end
NS_ASSUME_NONNULL_END
