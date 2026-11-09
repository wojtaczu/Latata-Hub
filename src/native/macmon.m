#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/ps/IOPowerSources.h>
#import <IOKit/ps/IOPSKeys.h>
#import <IOKit/hidsystem/IOHIDEventSystemClient.h>
#import <CoreWLAN/CoreWLAN.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <fts.h>
#include <sys/socket.h>
#include <signal.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <net/if_dl.h>
#include <net/if_mib.h>
#include <arpa/inet.h>

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDServiceClient *IOHIDServiceClientRef;
extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
extern int IOHIDEventSystemClientSetMatching(IOHIDEventSystemClientRef client, CFDictionaryRef match);
extern CFArrayRef IOHIDEventSystemClientCopyServices(IOHIDEventSystemClientRef client);
extern CFStringRef IOHIDServiceClientCopyProperty(IOHIDServiceClientRef service, CFStringRef key);
extern IOHIDEventRef IOHIDServiceClientCopyEvent(IOHIDServiceClientRef service, int64_t type, int32_t options, int64_t timeout);
extern double IOHIDEventGetFloatValue(IOHIDEventRef event, int32_t field);
extern CFTypeRef IOPSCopyPowerSourcesByType(int type);

static double round1(double val) {
    return round(val * 10.0) / 10.0;
}

static double round2(double val) {
    return round(val * 100.0) / 100.0;
}

static NSString *extractAppBundlePath(NSString *fullPath) {
    if (!fullPath || fullPath.length == 0) return @"";
    NSRange r = [fullPath rangeOfString:@".app/"];
    if (r.location != NSNotFound) {
        return [fullPath substringToIndex:(r.location + 4)];
    }
    if ([fullPath hasSuffix:@".app"]) {
        return fullPath;
    }
    return @"";
}

static uint64_t directorySizeFast(NSString *path) {
    if (!path || path.length == 0) return 0;
    NSFileManager *fm = [NSFileManager defaultManager];
    BOOL isDir = NO;
    if (![fm fileExistsAtPath:path isDirectory:&isDir]) return 0;
    if (!isDir) {
        NSDictionary *attrs = [fm attributesOfItemAtPath:path error:nil];
        return [attrs fileSize];
    }

    char *paths[2] = { (char *)[path fileSystemRepresentation], NULL };
    FTS *fts = fts_open(paths, FTS_PHYSICAL | FTS_NOCHDIR | FTS_XDEV, NULL);
    if (!fts) return 0;

    uint64_t total = 0;
    FTSENT *ent = NULL;
    while ((ent = fts_read(fts)) != NULL) {
        if (ent->fts_info == FTS_F && ent->fts_statp != NULL) {
            uint64_t blocksBytes = (uint64_t)ent->fts_statp->st_blocks * 512ULL;
            uint64_t logicalBytes = (uint64_t)ent->fts_statp->st_size;
            total += (blocksBytes > 0 ? blocksBytes : logicalBytes);
        }
    }
    fts_close(fts);
    return total;
}

static BOOL isProtectedCacheFolder(NSString *name) {
    if (!name || name.length == 0) return YES;
    NSSet *skip = [NSSet setWithArray:@[
        @"CloudKit",
        @"FamilyCircle",
        @"com.apple.Safari",
        @"com.apple.HomeKit",
        @"com.apple.ap.adprivacyd",
        @"com.apple.containermanagerd",
        @"com.apple.bird",
        @"GeoServices",
        @"google.GeminiMacOS",
        @"com.google.GeminiMacOS",
        @"pip",
        @"Homebrew",
        @"CocoaPods"
    ]];
    return [skip containsObject:name];
}

static NSArray<NSDictionary *> *extraAppCacheTargets(NSString *home) {
    NSString *appSup = [home stringByAppendingPathComponent:@"Library/Application Support"];
    return @[
        @{@"name": @"Brave Cache", @"path": [appSup stringByAppendingPathComponent:@"BraveSoftware/Brave-Browser/Default/Cache"]},
        @{@"name": @"Brave Code Cache", @"path": [appSup stringByAppendingPathComponent:@"BraveSoftware/Brave-Browser/Default/Code Cache"]},
        @{@"name": @"Brave ServiceWorker", @"path": [appSup stringByAppendingPathComponent:@"BraveSoftware/Brave-Browser/Default/Service Worker/CacheStorage"]},
        @{@"name": @"Chrome Cache", @"path": [appSup stringByAppendingPathComponent:@"Google/Chrome/Default/Cache"]},
        @{@"name": @"Chrome Code Cache", @"path": [appSup stringByAppendingPathComponent:@"Google/Chrome/Default/Code Cache"]},
        @{@"name": @"Discord Cache", @"path": [appSup stringByAppendingPathComponent:@"discord/Cache"]},
        @{@"name": @"Discord Code Cache", @"path": [appSup stringByAppendingPathComponent:@"discord/Code Cache"]},
        @{@"name": @"VS Code Cache", @"path": [appSup stringByAppendingPathComponent:@"Code/Cache"]},
        @{@"name": @"VS Code CachedData", @"path": [appSup stringByAppendingPathComponent:@"Code/CachedData"]},
        @{@"name": @"Spotify Cache", @"path": [appSup stringByAppendingPathComponent:@"Spotify/PersistentCache"]}
    ];
}

static NSDictionary *scanSystemJunk(void) {
    NSString *home = NSHomeDirectory();
    NSFileManager *fm = [NSFileManager defaultManager];

    // 1. User App Caches (~/Library/Caches)
    NSString *cachesDir = [home stringByAppendingPathComponent:@"Library/Caches"];
    uint64_t cachesBytes = 0;
    int cachesCount = 0;
    NSMutableArray *topCacheItems = [NSMutableArray array];
    NSArray *cacheSubdirs = [fm contentsOfDirectoryAtPath:cachesDir error:nil];
    for (NSString *sub in cacheSubdirs) {
        if ([sub hasPrefix:@"."] || isProtectedCacheFolder(sub)) continue;
        NSString *full = [cachesDir stringByAppendingPathComponent:sub];
        uint64_t sz = directorySizeFast(full);
        if (sz > 0) {
            cachesBytes += sz;
            cachesCount++;
            if (sz >= 5 * 1024 * 1024) {
                NSString *shortName = [[sub stringByReplacingOccurrencesOfString:@"com.apple." withString:@""]
                                       stringByReplacingOccurrencesOfString:@"com." withString:@""];
                [topCacheItems addObject:@{@"name": shortName, @"bytes": @(sz)}];
            }
        }
    }
    for (NSDictionary *ext in extraAppCacheTargets(home)) {
        uint64_t sz = directorySizeFast(ext[@"path"]);
        if (sz > 0) {
            cachesBytes += sz;
            cachesCount++;
            if (sz >= 5 * 1024 * 1024) {
                [topCacheItems addObject:@{@"name": ext[@"name"], @"bytes": @(sz)}];
            }
        }
    }
    [topCacheItems sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [b[@"bytes"] compare:a[@"bytes"]];
    }];
    NSMutableArray *topNames = [NSMutableArray array];
    for (NSUInteger i = 0; i < MIN((NSUInteger)3, topCacheItems.count); i++) {
        [topNames addObject:topCacheItems[i][@"name"]];
    }

    // 2. System & App Logs + Crash Reports (~/Library/Logs, CrashReporter)
    NSArray *logPaths = @[
        [home stringByAppendingPathComponent:@"Library/Logs"],
        [home stringByAppendingPathComponent:@"Library/Application Support/CrashReporter"]
    ];
    uint64_t logsBytes = 0;
    int logsCount = 0;
    for (NSString *lp in logPaths) {
        NSArray *subs = [fm contentsOfDirectoryAtPath:lp error:nil];
        for (NSString *sub in subs) {
            if ([sub hasPrefix:@"."]) continue;
            uint64_t sz = directorySizeFast([lp stringByAppendingPathComponent:sub]);
            if (sz > 0) {
                logsBytes += sz;
                logsCount++;
            }
        }
    }

    // 3. System Trash (~/.Trash)
    NSString *trashDir = [home stringByAppendingPathComponent:@".Trash"];
    uint64_t trashBytes = 0;
    int trashCount = 0;
    NSArray *trashItems = [fm contentsOfDirectoryAtPath:trashDir error:nil];
    for (NSString *item in trashItems) {
        if ([item isEqualToString:@"."] || [item isEqualToString:@".."] || [item isEqualToString:@".DS_Store"]) continue;
        uint64_t sz = directorySizeFast([trashDir stringByAppendingPathComponent:item]);
        trashBytes += sz;
        trashCount++;
    }

    // 4. Developer & Package Caches (npm, pip, Homebrew, Xcode DerivedData, CocoaPods, Gradle)
    NSDictionary *devPaths = @{
        @"npm": [home stringByAppendingPathComponent:@".npm/_cacache"],
        @"pip": [home stringByAppendingPathComponent:@"Library/Caches/pip"],
        @"Homebrew": [home stringByAppendingPathComponent:@"Library/Caches/Homebrew"],
        @"Xcode DerivedData": [home stringByAppendingPathComponent:@"Library/Developer/Xcode/DerivedData"],
        @"CocoaPods": [home stringByAppendingPathComponent:@"Library/Caches/CocoaPods"],
        @"Gradle": [home stringByAppendingPathComponent:@".gradle/caches"]
    };
    uint64_t devBytes = 0;
    int devCount = 0;
    NSMutableArray *devFoundNames = [NSMutableArray array];
    for (NSString *label in devPaths) {
        NSString *dp = devPaths[label];
        uint64_t sz = directorySizeFast(dp);
        if (sz > 64 * 1024) {
            devBytes += sz;
            devCount++;
            [devFoundNames addObject:label];
        }
    }

    // 5. Temp files ($TMPDIR excluding active tinyjs/tjs sockets)
    NSString *tmpDir = NSTemporaryDirectory() ?: @"/tmp";
    uint64_t tempBytes = 0;
    int tempCount = 0;
    NSArray *tmpItems = [fm contentsOfDirectoryAtPath:tmpDir error:nil];
    for (NSString *item in tmpItems) {
        if ([item hasPrefix:@"."] || [item hasPrefix:@"tinyjs-"] || [item hasPrefix:@"tjs-"] || [item hasPrefix:@"com.apple."]) continue;
        NSString *full = [tmpDir stringByAppendingPathComponent:item];
        uint64_t sz = directorySizeFast(full);
        if (sz > 0) {
            tempBytes += sz;
            tempCount++;
        }
    }

    uint64_t totalJunkBytes = cachesBytes + logsBytes + trashBytes + devBytes + tempBytes;
    NSArray *categories = @[
        @{
            @"id": @"caches",
            @"title": @"Pamięć podręczna aplikacji",
            @"subtitle": topNames.count > 0 ? [NSString stringWithFormat:@"~/Library/Caches (%@)", [topNames componentsJoinedByString:@", "]] : @"~/Library/Caches (bufory aplikacji)",
            @"bytes": @(cachesBytes),
            @"count": @(cachesCount)
        },
        @{
            @"id": @"dev",
            @"title": @"Cache deweloperski i pakietów",
            @"subtitle": devFoundNames.count > 0 ? [devFoundNames componentsJoinedByString:@" • "] : @"npm, pip, Homebrew, Xcode DerivedData",
            @"bytes": @(devBytes),
            @"count": @(devCount)
        },
        @{
            @"id": @"logs",
            @"title": @"Logi i raporty błędów",
            @"subtitle": @"~/Library/Logs & CrashReporter",
            @"bytes": @(logsBytes),
            @"count": @(logsCount)
        },
        @{
            @"id": @"trash",
            @"title": @"Kosz systemowy",
            @"subtitle": trashCount > 0 ? [NSString stringWithFormat:@"~/.Trash (%d elementów)", trashCount] : @"~/.Trash (Kosz jest pusty)",
            @"bytes": @(trashBytes),
            @"count": @(trashCount)
        },
        @{
            @"id": @"temp",
            @"title": @"Pliki tymczasowe i Cache DNS",
            @"subtitle": @"Pliki tymczasowe macOS + dscacheutil DNS",
            @"bytes": @(tempBytes),
            @"count": @(tempCount)
        }
    ];

    return @{
        @"totalBytes": @(totalJunkBytes),
        @"categories": categories
    };
}

static int removeDirectoryChildren(NSString *dirPath, BOOL (^shouldSkip)(NSString *itemName)) {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSArray *items = [fm contentsOfDirectoryAtPath:dirPath error:nil];
    int removed = 0;
    for (NSString *item in items) {
        if ([item isEqualToString:@"."] || [item isEqualToString:@".."]) continue;
        if (shouldSkip && shouldSkip(item)) continue;
        NSString *full = [dirPath stringByAppendingPathComponent:item];
        if ([fm removeItemAtPath:full error:nil]) {
            removed++;
        } else {
            // If top-level folder is locked by a running app, try removing its inner files
            NSArray *inner = [fm contentsOfDirectoryAtPath:full error:nil];
            for (NSString *inItem in inner) {
                NSString *inFull = [full stringByAppendingPathComponent:inItem];
                if ([fm removeItemAtPath:inFull error:nil]) {
                    removed++;
                }
            }
        }
    }
    return removed;
}

static NSDictionary *cleanSystemJunk(NSSet *selectedIds) {
    NSDictionary *beforeScan = scanSystemJunk();
    uint64_t beforeTotal = [beforeScan[@"totalBytes"] unsignedLongLongValue];
    NSString *home = NSHomeDirectory();
    int removedItems = 0;

    if ([selectedIds containsObject:@"caches"]) {
        NSString *cachesDir = [home stringByAppendingPathComponent:@"Library/Caches"];
        removedItems += removeDirectoryChildren(cachesDir, ^BOOL(NSString *item) {
            return [item hasPrefix:@"."] || isProtectedCacheFolder(item);
        });
        for (NSDictionary *ext in extraAppCacheTargets(home)) {
            removedItems += removeDirectoryChildren(ext[@"path"], nil);
        }
    }

    if ([selectedIds containsObject:@"logs"]) {
        removedItems += removeDirectoryChildren([home stringByAppendingPathComponent:@"Library/Logs"], ^BOOL(NSString *item) {
            return [item hasPrefix:@"."];
        });
        removedItems += removeDirectoryChildren([home stringByAppendingPathComponent:@"Library/Application Support/CrashReporter"], ^BOOL(NSString *item) {
            return [item hasPrefix:@"."];
        });
    }

    if ([selectedIds containsObject:@"trash"]) {
        removedItems += removeDirectoryChildren([home stringByAppendingPathComponent:@".Trash"], ^BOOL(NSString *item) {
            return [item isEqualToString:@".DS_Store"];
        });
    }

    if ([selectedIds containsObject:@"dev"]) {
        NSArray *devDirs = @[
            [home stringByAppendingPathComponent:@".npm/_cacache"],
            [home stringByAppendingPathComponent:@"Library/Caches/pip"],
            [home stringByAppendingPathComponent:@"Library/Caches/Homebrew"],
            [home stringByAppendingPathComponent:@"Library/Developer/Xcode/DerivedData"],
            [home stringByAppendingPathComponent:@"Library/Caches/CocoaPods"],
            [home stringByAppendingPathComponent:@".gradle/caches"]
        ];
        for (NSString *dd in devDirs) {
            removedItems += removeDirectoryChildren(dd, nil);
        }
    }

    if ([selectedIds containsObject:@"temp"]) {
        NSString *tmpDir = NSTemporaryDirectory() ?: @"/tmp";
        removedItems += removeDirectoryChildren(tmpDir, ^BOOL(NSString *item) {
            return [item hasPrefix:@"."] || [item hasPrefix:@"tinyjs-"] || [item hasPrefix:@"tjs-"] || [item hasPrefix:@"com.apple."];
        });
        NSTask *task = [[NSTask alloc] init];
        task.launchPath = @"/usr/bin/dscacheutil";
        task.arguments = @[@"-flushcache"];
        @try {
            [task launch];
            [task waitUntilExit];
        } @catch (id _) {}
    }

    NSDictionary *afterScan = scanSystemJunk();
    uint64_t afterTotal = [afterScan[@"totalBytes"] unsignedLongLongValue];
    uint64_t freedBytes = (beforeTotal > afterTotal) ? (beforeTotal - afterTotal) : 0;

    return @{
        @"ok": @(YES),
        @"freedBytes": @(freedBytes),
        @"removedItems": @(removedItems),
        @"scan": afterScan
    };
}

static NSSet *homeTccProtectedFolders(void) {
    static NSSet *s = nil;
    if (!s) {
        s = [NSSet setWithArray:@[
            @"Desktop", @"Documents", @"Downloads", @"Pictures", @"Music", @"Movies",
            @"Photos Library.photoslibrary", @".Trash"
        ]];
    }
    return s;
}

static NSSet *tccProtectedFolderNames(void) {
    static NSSet *s = nil;
    if (!s) {
        s = [NSSet setWithArray:@[
            @"Mail", @"Messages", @"Safari", @"Calendars", @"Contacts",
            @"Reminders", @"Photos Library.photoslibrary", @"CloudStorage",
            @"Mobile Documents", @"Biome", @"IdentityServices", @"Suggestions",
            @"PersonalizationPortrait", @"HomeKit", @"Accounts", @"DoNotDisturb",
            @"StatusKit", @"Daemon Containers", @"Autosave Information",
            @"CoreSpotlight", @"Cookies", @"PassKit", @"Sharing",
            @".Spotlight-V100", @".fseventsd", @".DocumentRevisions-V100", @".TemporaryItems"
        ]];
    }
    return s;
}

static NSString *abbreviateTildePath(NSString *fullPath, NSString *home) {
    if (!fullPath) return @"";
    if ([fullPath isEqualToString:home]) return @"~";
    NSString *homeSlash = [home stringByAppendingString:@"/"];
    if ([fullPath hasPrefix:homeSlash]) {
        return [@"~/" stringByAppendingString:[fullPath substringFromIndex:homeSlash.length]];
    }
    return fullPath;
}

static void runSingleFtsPass(
    NSString *scanRoot,
    NSString *home,
    BOOL isHomeRoot,
    NSUInteger maxItems,
    NSMutableArray<NSDictionary *> *candidateDirs,
    NSMutableArray<NSDictionary *> *topFiles,
    uint64_t *outTotalBytes
) {
    char *paths[2] = { (char *)[scanRoot fileSystemRepresentation], NULL };
    FTS *fts = fts_open(paths, FTS_PHYSICAL | FTS_NOCHDIR | FTS_XDEV, NULL);
    if (!fts) return;

    NSSet *skipNames = tccProtectedFolderNames();
    uint64_t minTopFileBytes = isHomeRoot ? (128ULL * 1024ULL) : 1024ULL;
    if (topFiles.count == maxItems) {
        minTopFileBytes = [topFiles.lastObject[@"bytes"] unsignedLongLongValue];
    }
    uint64_t totalRootBytes = 0;
    uint64_t visitedCount = 0;
    BOOL rootIsApp = [[scanRoot lowercaseString] hasSuffix:@".app"];

    FTSENT *ent = NULL;
    while ((ent = fts_read(fts)) != NULL) {
        visitedCount++;
        if (ent->fts_info == FTS_D) {
            ent->fts_number = 0;
            if (ent->fts_level > 0 && ent->fts_name[0] != '\0') {
                NSString *dName = [NSString stringWithUTF8String:ent->fts_name];
                if (dName) {
                    if (isHomeRoot && ent->fts_level == 1 && [homeTccProtectedFolders() containsObject:dName]) {
                        fts_set(fts, ent, FTS_SKIP);
                        continue;
                    }
                    if ([skipNames containsObject:dName]) {
                        fts_set(fts, ent, FTS_SKIP);
                        continue;
                    }
                }
                if (visitedCount > 180000 && ent->fts_level >= 5) {
                    fts_set(fts, ent, FTS_SKIP);
                    continue;
                }
            }
        } else if (ent->fts_info == FTS_F || ent->fts_info == FTS_SL || ent->fts_info == FTS_SLNONE) {
            uint64_t blocksBytes = (ent->fts_statp != NULL) ? ((uint64_t)ent->fts_statp->st_blocks * 512ULL) : 0;
            uint64_t logicalBytes = (ent->fts_statp != NULL) ? (uint64_t)ent->fts_statp->st_size : 0;
            uint64_t sz = (blocksBytes > 0) ? blocksBytes : ((logicalBytes <= 4096) ? logicalBytes : 0);

            if (ent->fts_parent != NULL) {
                ent->fts_parent->fts_number += (int64_t)sz;
            }

            if (ent->fts_info == FTS_F && sz >= minTopFileBytes && ent->fts_name[0] != '\0') {
                if (strcmp(ent->fts_name, ".DS_Store") == 0) continue;
                if (topFiles.count < maxItems || sz > minTopFileBytes) {
                    NSString *fPath = [NSString stringWithUTF8String:ent->fts_path] ?: @"";
                    if (!rootIsApp && ([fPath containsString:@".app/"] || [fPath containsString:@"/.git/"])) {
                        continue;
                    }
                    NSString *fName = [NSString stringWithUTF8String:ent->fts_name] ?: @"plik";
                    NSString *shortP = abbreviateTildePath(fPath, home);
                    NSString *ext = [[fName pathExtension] lowercaseString] ?: @"";
                    [topFiles addObject:@{
                        @"name": fName,
                        @"path": fPath,
                        @"shortPath": shortP,
                        @"bytes": @(sz),
                        @"ext": ext
                    }];
                    [topFiles sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
                        return [b[@"bytes"] compare:a[@"bytes"]];
                    }];
                    if (topFiles.count > maxItems) {
                        [topFiles removeLastObject];
                    }
                    if (topFiles.count == maxItems) {
                        minTopFileBytes = [topFiles.lastObject[@"bytes"] unsignedLongLongValue];
                    }
                }
            }
        } else if (ent->fts_info == FTS_DP) {
            uint64_t dirSz = (ent->fts_number > 0) ? (uint64_t)ent->fts_number : 0;
            if (ent->fts_level == 0) {
                totalRootBytes = dirSz;
            } else {
                if (ent->fts_parent != NULL) {
                    ent->fts_parent->fts_number += (int64_t)dirSz;
                }
                if (dirSz > 0 && ent->fts_name[0] != '\0') {
                    NSString *dName = [NSString stringWithUTF8String:ent->fts_name] ?: @"katalog";
                    BOOL shouldCollect = NO;
                    NSString *displayDirName = dName;

                    if (isHomeRoot) {
                        if (ent->fts_level == 1 && ![dName isEqualToString:@"Library"]) {
                            shouldCollect = YES;
                        } else if (ent->fts_level == 2 && ent->fts_parent != NULL &&
                                   strcmp(ent->fts_parent->fts_name, "Library") == 0) {
                            shouldCollect = YES;
                            displayDirName = [NSString stringWithFormat:@"Library/%@", dName];
                        }
                    } else {
                        if (ent->fts_level == 1) {
                            shouldCollect = YES;
                        }
                    }

                    if (shouldCollect) {
                        NSString *dPath = [NSString stringWithUTF8String:ent->fts_path] ?: @"";
                        NSString *shortP = abbreviateTildePath(dPath, home);
                        BOOL isApp = [[dName lowercaseString] hasSuffix:@".app"];
                        [candidateDirs addObject:@{
                            @"name": displayDirName,
                            @"path": dPath,
                            @"shortPath": shortP,
                            @"bytes": @(dirSz),
                            @"isApp": @(isApp)
                        }];
                    }
                }
            }
        }
    }
    fts_close(fts);
    if (outTotalBytes) {
        *outTotalBytes += totalRootBytes;
    }
}

static NSDictionary *scanDiskUsage(NSString *customPath) {
    NSString *home = NSHomeDirectory();
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *rootPath = home;
    if (customPath && customPath.length > 0) {
        NSString *cand = [[customPath stringByExpandingTildeInPath] stringByStandardizingPath];
        BOOL isDir = NO;
        if ([fm fileExistsAtPath:cand isDirectory:&isDir] && isDir) {
            rootPath = cand;
        }
    }

    BOOL isHomeRoot = [rootPath isEqualToString:home];
    NSString *displayPath = isHomeRoot ? @"~ (Katalog domowy)" : abbreviateTildePath(rootPath, home);
    NSString *parentPath = @"";
    if (!isHomeRoot && ![rootPath isEqualToString:@"/"] && ![rootPath isEqualToString:@"/Applications"]) {
        parentPath = [rootPath stringByDeletingLastPathComponent];
    } else if (!isHomeRoot) {
        parentPath = home;
    }

    NSMutableArray<NSDictionary *> *candidateDirs = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *topFiles = [NSMutableArray array];
    NSUInteger maxItems = 10;
    uint64_t totalRootBytes = 0;

    runSingleFtsPass(rootPath, home, isHomeRoot, maxItems, candidateDirs, topFiles, &totalRootBytes);

    // Fallback if root directory listing was restricted (e.g. inside test sandbox)
    if (isHomeRoot && candidateDirs.count == 0 && topFiles.count == 0) {
        if ([fm fileExistsAtPath:@"/Applications"]) {
            runSingleFtsPass(@"/Applications", home, NO, maxItems, candidateDirs, topFiles, &totalRootBytes);
        }
    }

    [candidateDirs sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [b[@"bytes"] compare:a[@"bytes"]];
    }];
    NSArray *topDirsResult = (candidateDirs.count > maxItems)
        ? [candidateDirs subarrayWithRange:NSMakeRange(0, maxItems)]
        : candidateDirs;

    return @{
        @"ok": @(YES),
        @"rootPath": rootPath,
        @"displayPath": displayPath,
        @"parentPath": parentPath,
        @"totalScannedBytes": @(totalRootBytes),
        @"topDirs": topDirsResult,
        @"topFiles": topFiles
    };
}

static NSString *iconDataUrlForPath(NSString *path) {
    if (!path || path.length == 0) return nil;
    // Only resolve native icons for installed application bundles in /Applications or /System.
    // Never peek into user directories (~/Desktop, ~/Documents, ~/Downloads etc.) to prevent macOS TCC privacy dialogs.
    if (![path hasPrefix:@"/Applications"] && ![path hasPrefix:@"/System"]) {
        return nil;
    }
    NSImage *icon = [[NSWorkspace sharedWorkspace] iconForFile:path];
    if (!icon) return nil;
    int px = 32;
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
        initWithBitmapDataPlanes:NULL
                      pixelsWide:px
                      pixelsHigh:px
                   bitsPerSample:8
                 samplesPerPixel:4
                        hasAlpha:YES
                        isPlanar:NO
                  colorSpaceName:NSCalibratedRGBColorSpace
                     bytesPerRow:0
                    bitsPerPixel:0];
    if (!rep) return nil;
    rep.size = NSMakeSize(px, px);
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:rep]];
    [[NSGraphicsContext currentContext] setImageInterpolation:NSImageInterpolationHigh];
    [icon drawInRect:NSMakeRect(0, 0, px, px)
            fromRect:NSZeroRect
           operation:NSCompositingOperationSourceOver
            fraction:1.0];
    [NSGraphicsContext restoreGraphicsState];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png) return nil;
    return [NSString stringWithFormat:@"data:image/png;base64,%@", [png base64EncodedStringWithOptions:0]];
}

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (argc >= 3 && strcmp(argv[1], "--icon") == 0) {
            NSString *targetPath = [NSString stringWithUTF8String:argv[2]];
            NSString *dataUrl = iconDataUrlForPath(targetPath);
            NSDictionary *res = @{@"icon": dataUrl ?: [NSNull null]};
            NSData *d = [NSJSONSerialization dataWithJSONObject:res options:0 error:nil];
            if (d) {
                fwrite(d.bytes, 1, d.length, stdout);
                fwrite("\n", 1, 1, stdout);
            }
            return 0;
        }

        if (argc >= 3 && strcmp(argv[1], "--icons") == 0) {
            NSMutableDictionary *iconsDict = [NSMutableDictionary dictionary];
            for (int i = 2; i < argc; i++) {
                NSString *p = [NSString stringWithUTF8String:argv[i]];
                if (p && p.length > 0) {
                    NSString *dataUrl = iconDataUrlForPath(p);
                    if (dataUrl) {
                        iconsDict[p] = dataUrl;
                    }
                }
            }
            NSData *d = [NSJSONSerialization dataWithJSONObject:iconsDict options:0 error:nil];
            if (d) {
                fwrite(d.bytes, 1, d.length, stdout);
                fwrite("\n", 1, 1, stdout);
            }
            return 0;
        }

        if (argc >= 3 && strcmp(argv[1], "--kill") == 0) {
            pid_t targetPid = (pid_t)atoi(argv[2]);
            int sig = (argc >= 4) ? atoi(argv[3]) : SIGTERM;
            if (sig != SIGKILL && sig != SIGTERM && sig != SIGINT) sig = SIGTERM;
            int rc = (targetPid > 1) ? kill(targetPid, sig) : -1;
            NSDictionary *res = @{
                @"ok": @(rc == 0),
                @"pid": @(targetPid),
                @"signal": @(sig),
                @"errno": @(rc == 0 ? 0 : errno)
            };
            NSData *d = [NSJSONSerialization dataWithJSONObject:res options:0 error:nil];
            if (d) {
                fwrite(d.bytes, 1, d.length, stdout);
                fwrite("\n", 1, 1, stdout);
            }
            return 0;
        }

        if (argc >= 2 && strcmp(argv[1], "--flush-cache") == 0) {
            NSTask *task = [[NSTask alloc] init];
            task.launchPath = @"/usr/bin/dscacheutil";
            task.arguments = @[@"-flushcache"];
            @try {
                [task launch];
                [task waitUntilExit];
            } @catch (id _) {}
            NSDictionary *res = @{@"ok": @(YES)};
            NSData *d = [NSJSONSerialization dataWithJSONObject:res options:0 error:nil];
            if (d) {
                fwrite(d.bytes, 1, d.length, stdout);
                fwrite("\n", 1, 1, stdout);
            }
            return 0;
        }

        if (argc >= 2 && strcmp(argv[1], "--scan-junk") == 0) {
            NSDictionary *res = scanSystemJunk();
            NSData *d = [NSJSONSerialization dataWithJSONObject:res options:0 error:nil];
            if (d) {
                fwrite(d.bytes, 1, d.length, stdout);
                fwrite("\n", 1, 1, stdout);
            }
            return 0;
        }

        if (argc >= 2 && strcmp(argv[1], "--clean-junk") == 0) {
            NSMutableSet *sel = [NSMutableSet set];
            if (argc == 2) {
                [sel addObjectsFromArray:@[@"caches", @"logs", @"trash", @"dev", @"temp"]];
            } else {
                for (int i = 2; i < argc; i++) {
                    NSString *arg = [NSString stringWithUTF8String:argv[i]];
                    if (arg.length > 0) [sel addObject:arg];
                }
            }
            NSDictionary *res = cleanSystemJunk(sel);
            NSData *d = [NSJSONSerialization dataWithJSONObject:res options:0 error:nil];
            if (d) {
                fwrite(d.bytes, 1, d.length, stdout);
                fwrite("\n", 1, 1, stdout);
            }
            return 0;
        }

        if (argc >= 2 && strcmp(argv[1], "--scan-disk") == 0) {
            NSString *customPath = (argc >= 3) ? [NSString stringWithUTF8String:argv[2]] : nil;
            NSDictionary *res = scanDiskUsage(customPath);
            NSData *d = [NSJSONSerialization dataWithJSONObject:res options:0 error:nil];
            if (d) {
                fwrite(d.bytes, 1, d.length, stdout);
                fwrite("\n", 1, 1, stdout);
            }
            return 0;
        }

        if (argc >= 3 && strcmp(argv[1], "--reveal") == 0) {
            NSString *targetPath = [NSString stringWithUTF8String:argv[2]];
            BOOL ok = NO;
            if (targetPath && targetPath.length > 0) {
                NSString *expanded = [[targetPath stringByExpandingTildeInPath] stringByStandardizingPath];
                if ([[NSFileManager defaultManager] fileExistsAtPath:expanded]) {
                    NSURL *url = [NSURL fileURLWithPath:expanded];
                    [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:@[url]];
                    ok = YES;
                }
            }
            NSDictionary *res = @{@"ok": @(ok)};
            NSData *d = [NSJSONSerialization dataWithJSONObject:res options:0 error:nil];
            if (d) {
                fwrite(d.bytes, 1, d.length, stdout);
                fwrite("\n", 1, 1, stdout);
            }
            return 0;
        }

        NSMutableDictionary *root = [NSMutableDictionary dictionary];

        // 1. CPU topology extra info (P-cores / E-cores / chip brand)
        int pCores = 0, eCores = 0;
        size_t intSize = sizeof(int);
        sysctlbyname("hw.perflevel0.logicalcpu", &pCores, &intSize, NULL, 0);
        intSize = sizeof(int);
        sysctlbyname("hw.perflevel1.logicalcpu", &eCores, &intSize, NULL, 0);

        char brandBuf[128] = {0};
        size_t brandLen = sizeof(brandBuf) - 1;
        sysctlbyname("machdep.cpu.brand_string", brandBuf, &brandLen, NULL, 0);

        char hwModel[64] = {0};
        size_t modelLen = sizeof(hwModel) - 1;
        sysctlbyname("hw.model", hwModel, &modelLen, NULL, 0);

        root[@"cpuMeta"] = @{
            @"brand": brandBuf[0] ? [NSString stringWithUTF8String:brandBuf] : @"Apple Silicon",
            @"hwModel": hwModel[0] ? [NSString stringWithUTF8String:hwModel] : @"Mac",
            @"pCores": @(pCores),
            @"eCores": @(eCores)
        };

        // 2. Memory (Mach VM + sysctl)
        uint64_t totalMem = 0;
        size_t size = sizeof(totalMem);
        sysctlbyname("hw.memsize", &totalMem, &size, NULL, 0);

        vm_size_t pageSize = 16384;
        host_page_size(mach_host_self(), &pageSize);
        vm_statistics64_data_t vmStat;
        mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
        if (host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vmStat, &count) == KERN_SUCCESS) {
            uint64_t appMem = 0;
            if (vmStat.internal_page_count > vmStat.purgeable_count) {
                appMem = (uint64_t)(vmStat.internal_page_count - vmStat.purgeable_count) * pageSize;
            }
            uint64_t wiredMem = (uint64_t)vmStat.wire_count * pageSize;
            uint64_t compressedMem = (uint64_t)vmStat.compressor_page_count * pageSize;
            uint64_t usedMem = appMem + wiredMem + compressedMem;
            if (usedMem > totalMem) usedMem = totalMem;
            uint64_t cachedFiles = (uint64_t)(vmStat.external_page_count + vmStat.purgeable_count) * pageSize;
            uint64_t freeMem = (totalMem > usedMem) ? (totalMem - usedMem) : 0;

            struct xsw_usage swapUsage = {0};
            size_t swapSize = sizeof(swapUsage);
            sysctlbyname("vm.swapusage", &swapUsage, &swapSize, NULL, 0);

            int pressureLevel = 1;
            size_t pSize = sizeof(pressureLevel);
            sysctlbyname("kern.memorystatus_vm_pressure_level", &pressureLevel, &pSize, NULL, 0);

            root[@"memory"] = @{
                @"total": @(totalMem),
                @"used": @(usedMem),
                @"app": @(appMem),
                @"wired": @(wiredMem),
                @"compressed": @(compressedMem),
                @"cached": @(cachedFiles),
                @"free": @(freeMem),
                @"swapTotal": @(swapUsage.xsu_total),
                @"swapUsed": @(swapUsage.xsu_used),
                @"pressureLevel": @(pressureLevel)
            };
        }

        // 3. Network interfaces: 64-bit counters via IFMIB_IFDATA + IPv4 via getifaddrs
        uint64_t totalRx = 0, totalTx = 0;
        int ifCount = 0;
        size_t ifCountLen = sizeof(ifCount);
        int mib[6] = {CTL_NET, PF_LINK, NETLINK_GENERIC, IFMIB_SYSTEM, IFMIB_IFCOUNT, 0};
        if (sysctl(mib, 5, &ifCount, &ifCountLen, NULL, 0) == 0) {
            for (int i = 1; i <= ifCount; i++) {
                struct ifmibdata ifmd;
                size_t dlen = sizeof(ifmd);
                int dmib[6] = {CTL_NET, PF_LINK, NETLINK_GENERIC, IFMIB_IFDATA, i, IFDATA_GENERAL};
                if (sysctl(dmib, 6, &ifmd, &dlen, NULL, 0) == 0) {
                    if (strncmp(ifmd.ifmd_name, "en", 2) == 0) {
                        totalRx += ifmd.ifmd_data.ifi_ibytes;
                        totalTx += ifmd.ifmd_data.ifi_obytes;
                    }
                }
            }
        }

        struct ifaddrs *ifap = NULL;
        NSString *primaryIp = @"—";
        NSString *primaryIf = @"en0";
        if (getifaddrs(&ifap) == 0) {
            for (struct ifaddrs *ifa = ifap; ifa != NULL; ifa = ifa->ifa_next) {
                if (!ifa->ifa_name || !ifa->ifa_addr) continue;
                NSString *name = [NSString stringWithUTF8String:ifa->ifa_name];
                if (ifa->ifa_addr->sa_family == AF_INET && [name hasPrefix:@"en"]) {
                    char addrBuf[INET_ADDRSTRLEN];
                    struct sockaddr_in *sin = (struct sockaddr_in *)ifa->ifa_addr;
                    if (inet_ntop(AF_INET, &sin->sin_addr, addrBuf, sizeof(addrBuf))) {
                        primaryIp = [NSString stringWithUTF8String:addrBuf];
                        primaryIf = name;
                    }
                }
            }
            freeifaddrs(ifap);
        }

        root[@"network"] = @{
            @"rxBytes": @(totalRx),
            @"txBytes": @(totalTx),
            @"interface": primaryIf,
            @"ip": primaryIp
        };

        // 4. Wi-Fi extended details via CoreWLAN
        CWWiFiClient *wifiClient = [CWWiFiClient sharedWiFiClient];
        CWInterface *wifiIf = [wifiClient interface];
        if (wifiIf) {
            long rssi = (long)wifiIf.rssiValue;
            long noise = (long)wifiIf.noiseMeasurement;
            double txRate = wifiIf.transmitRate;
            long chNum = wifiIf.wlanChannel ? (long)wifiIf.wlanChannel.channelNumber : 0;
            long chBand = wifiIf.wlanChannel ? (long)wifiIf.wlanChannel.channelBand : 0;
            long chWidth = wifiIf.wlanChannel ? (long)wifiIf.wlanChannel.channelWidth : 0;
            NSString *bandStr = @"—";
            if (chBand == 1) bandStr = @"2.4 GHz";
            else if (chBand == 2) bandStr = @"5 GHz";
            else if (chBand == 3) bandStr = @"6 GHz";

            int widthMHz = 20;
            if (chWidth == 1) widthMHz = 20;
            else if (chWidth == 2) widthMHz = 40;
            else if (chWidth == 3) widthMHz = 80;
            else if (chWidth == 4) widthMHz = 160;

            root[@"wifiExtra"] = @{
                @"interface": wifiIf.interfaceName ?: @"en0",
                @"ssid": wifiIf.ssid ?: [NSNull null],
                @"rssi": @(rssi),
                @"noise": @(noise),
                @"snr": @(rssi - noise),
                @"txRate": @(round1(txRate)),
                @"channel": @(chNum),
                @"band": bandStr,
                @"widthMHz": @(widthMHz),
                @"powerOn": @(wifiIf.powerOn)
            };
        }

        // 5. GPU (IOAccelerator)
        io_iterator_t accelIter = 0;
        NSMutableDictionary *gpuDict = [NSMutableDictionary dictionaryWithDictionary:@{
            @"deviceUtilization": @(0),
            @"rendererUtilization": @(0),
            @"tilerUtilization": @(0),
            @"vramUsed": @(0),
            @"vramAlloc": @(0),
            @"model": brandBuf[0] ? [NSString stringWithUTF8String:brandBuf] : @"Apple GPU"
        }];
        if (IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &accelIter) == KERN_SUCCESS) {
            io_object_t service;
            while ((service = IOIteratorNext(accelIter))) {
                CFMutableDictionaryRef props = NULL;
                if (IORegistryEntryCreateCFProperties(service, &props, kCFAllocatorDefault, kNilOptions) == KERN_SUCCESS && props) {
                    NSDictionary *dict = (__bridge NSDictionary *)props;
                    NSDictionary *perf = dict[@"PerformanceStatistics"];
                    if (perf) {
                        if (perf[@"Device Utilization %"]) gpuDict[@"deviceUtilization"] = perf[@"Device Utilization %"];
                        if (perf[@"Renderer Utilization %"]) gpuDict[@"rendererUtilization"] = perf[@"Renderer Utilization %"];
                        if (perf[@"Tiler Utilization %"]) gpuDict[@"tilerUtilization"] = perf[@"Tiler Utilization %"];
                        if (perf[@"In use system memory"]) gpuDict[@"vramUsed"] = perf[@"In use system memory"];
                        if (perf[@"Alloc system memory"]) gpuDict[@"vramAlloc"] = perf[@"Alloc system memory"];
                    }
                    if (dict[@"model"] && [dict[@"model"] isKindOfClass:[NSString class]]) {
                        gpuDict[@"model"] = dict[@"model"];
                    }
                    CFRelease(props);
                }
                IOObjectRelease(service);
            }
            IOObjectRelease(accelIter);
        }
        root[@"gpu"] = gpuDict;

        // 6. Temperatures (IOHIDEventSystemClient)
        NSDictionary *match = @{@"PrimaryUsagePage": @(0xff00), @"PrimaryUsage": @(5)};
        IOHIDEventSystemClientRef hidSystem = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
        IOHIDEventSystemClientSetMatching(hidSystem, (__bridge CFDictionaryRef)match);
        CFArrayRef services = IOHIDEventSystemClientCopyServices(hidSystem);
        double pSum = 0, eSum = 0, gpuSum = 0, socSum = 0, nandSum = 0, battSum = 0;
        int pCnt = 0, eCnt = 0, gpuCnt = 0, socCnt = 0, nandCnt = 0, battCnt = 0;
        double maxDie = 0;
        if (services) {
            CFIndex sCount = CFArrayGetCount(services);
            for (CFIndex i = 0; i < sCount; i++) {
                IOHIDServiceClientRef sc = (IOHIDServiceClientRef)CFArrayGetValueAtIndex(services, i);
                CFStringRef nameRef = IOHIDServiceClientCopyProperty(sc, CFSTR("Product"));
                IOHIDEventRef event = IOHIDServiceClientCopyEvent(sc, 15, 0, 0);
                if (nameRef && event) {
                    NSString *sName = (__bridge NSString *)nameRef;
                    double t = IOHIDEventGetFloatValue(event, (15 << 16));
                    if (t > 10.0 && t < 125.0) {
                        if ([sName hasPrefix:@"pACC"]) {
                            pSum += t; pCnt++;
                            if (t > maxDie) maxDie = t;
                        } else if ([sName hasPrefix:@"eACC"]) {
                            eSum += t; eCnt++;
                            if (t > maxDie) maxDie = t;
                        } else if ([sName hasPrefix:@"GPU MTR"]) {
                            gpuSum += t; gpuCnt++;
                            if (t > maxDie) maxDie = t;
                        } else if ([sName containsString:@"SOC"] || [sName hasPrefix:@"PMU tdie"] || [sName hasPrefix:@"PMU2 tdie"]) {
                            socSum += t; socCnt++;
                            if (t > maxDie) maxDie = t;
                        } else if ([sName hasPrefix:@"NAND"]) {
                            nandSum += t; nandCnt++;
                        } else if ([sName containsString:@"battery"]) {
                            battSum += t; battCnt++;
                        }
                    }
                }
                if (nameRef) CFRelease(nameRef);
                if (event) CFRelease(event);
            }
            CFRelease(services);
        }
        CFRelease(hidSystem);

        double cpuAvg = (pCnt + eCnt > 0) ? ((pSum + eSum) / (pCnt + eCnt)) : (socCnt > 0 ? socSum / socCnt : 0);
        NSProcessInfoThermalState thermalState = [[NSProcessInfo processInfo] thermalState];
        root[@"temps"] = @{
            @"cpu": @(round1(cpuAvg)),
            @"pCore": @(pCnt > 0 ? round1(pSum / pCnt) : 0),
            @"eCore": @(eCnt > 0 ? round1(eSum / eCnt) : 0),
            @"gpu": @(gpuCnt > 0 ? round1(gpuSum / gpuCnt) : (socCnt > 0 ? round1(socSum / socCnt) : 0)),
            @"soc": @(socCnt > 0 ? round1(socSum / socCnt) : 0),
            @"maxDie": @(round1(maxDie)),
            @"ssd": @(nandCnt > 0 ? round1(nandSum / nandCnt) : 0),
            @"battery": @(battCnt > 0 ? round1(battSum / battCnt) : 0),
            @"thermalState": @(thermalState)
        };

        // 7. Battery extended details (AppleSmartBattery)
        io_service_t battService = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSmartBattery"));
        if (battService) {
            CFMutableDictionaryRef bProps = NULL;
            if (IORegistryEntryCreateCFProperties(battService, &bProps, kCFAllocatorDefault, kNilOptions) == KERN_SUCCESS && bProps) {
                NSDictionary *b = (__bridge NSDictionary *)bProps;
                NSDictionary *bData = b[@"BatteryData"];
                NSDictionary *pTele = b[@"PowerTelemetryData"];
                NSDictionary *adapter = b[@"AdapterDetails"];
                int designCap = [bData[@"DesignCapacity"] intValue] ?: [b[@"DesignCapacity"] intValue];
                int nomCap = [bData[@"NominalChargeCapacity"] intValue] ?: [b[@"NominalChargeCapacity"] intValue];
                double health = (designCap > 0 && nomCap > 0) ? MIN(100.0, round1(((double)nomCap / (double)designCap) * 100.0)) : 100.0;
                double voltageV = [b[@"Voltage"] doubleValue] / 1000.0;
                double amperageA = [b[@"Amperage"] doubleValue] / 1000.0;
                double sysLoadW = [pTele[@"SystemLoad"] doubleValue] / 1000.0;
                double sysInW = [pTele[@"SystemPowerIn"] doubleValue] / 1000.0;
                root[@"batteryExtra"] = @{
                    @"cycleCount": b[@"CycleCount"] ?: @(0),
                    @"healthPercent": @(health),
                    @"designCapacity": @(designCap),
                    @"nominalCapacity": @(nomCap),
                    @"voltageV": @(round2(voltageV)),
                    @"amperageA": @(round2(amperageA)),
                    @"systemLoadWatts": @(round1(sysLoadW)),
                    @"powerInWatts": @(round1(sysInW)),
                    @"adapterWatts": adapter[@"Watts"] ?: @(0)
                };
                CFRelease(bProps);
            }
            IOObjectRelease(battService);
        }

        // 8. Disk space (Root SSD/HDD + all mounted external HDD/SSD/USB volumes)
        NSURL *fileURL = [NSURL fileURLWithPath:@"/"];
        NSArray *volKeys = @[
            NSURLVolumeTotalCapacityKey,
            NSURLVolumeAvailableCapacityForImportantUsageKey,
            NSURLVolumeAvailableCapacityKey,
            NSURLVolumeNameKey,
            NSURLVolumeIsInternalKey,
            NSURLVolumeIsRemovableKey,
            NSURLVolumeIsLocalKey
        ];
        NSDictionary *volVals = [fileURL resourceValuesForKeys:volKeys error:nil];
        if (volVals) {
            uint64_t totalCap = [volVals[NSURLVolumeTotalCapacityKey] unsignedLongLongValue];
            uint64_t availImportant = [volVals[NSURLVolumeAvailableCapacityForImportantUsageKey] unsignedLongLongValue];
            uint64_t availStrict = [volVals[NSURLVolumeAvailableCapacityKey] unsignedLongLongValue];
            uint64_t avail = availImportant > 0 ? availImportant : availStrict;
            uint64_t purgeable = (avail > availStrict) ? (avail - availStrict) : 0;
            uint64_t used = totalCap > avail ? (totalCap - avail) : 0;

            NSMutableArray *volumesList = [NSMutableArray array];
            NSString *rootName = volVals[NSURLVolumeNameKey] ?: @"Macintosh HD";
            [volumesList addObject:@{
                @"name": rootName,
                @"mountPoint": @"/",
                @"total": @(totalCap),
                @"free": @(avail),
                @"freeStrict": @(availStrict),
                @"purgeable": @(purgeable),
                @"used": @(used),
                @"isInternal": @(YES)
            }];

            NSArray<NSURL *> *mountedURLs = [[NSFileManager defaultManager]
                mountedVolumeURLsIncludingResourceValuesForKeys:volKeys
                options:NSVolumeEnumerationSkipHiddenVolumes];
            NSMutableSet *seenNames = [NSMutableSet setWithObject:rootName];
            for (NSURL *vUrl in mountedURLs) {
                NSString *vPath = [vUrl path];
                if (!vPath || [vPath isEqualToString:@"/"] || [vPath hasPrefix:@"/System/"]) continue;
                NSDictionary *vv = [vUrl resourceValuesForKeys:volKeys error:nil];
                if (!vv) continue;
                NSString *vName = vv[NSURLVolumeNameKey] ?: [vPath lastPathComponent];
                if ([seenNames containsObject:vName]) continue;
                uint64_t vTot = [vv[NSURLVolumeTotalCapacityKey] unsignedLongLongValue];
                if (vTot < 64ULL * 1024ULL * 1024ULL) continue;
                uint64_t vImp = [vv[NSURLVolumeAvailableCapacityForImportantUsageKey] unsignedLongLongValue];
                uint64_t vStr = [vv[NSURLVolumeAvailableCapacityKey] unsignedLongLongValue];
                uint64_t vFree = vImp > 0 ? vImp : vStr;
                uint64_t vUsed = vTot > vFree ? (vTot - vFree) : 0;
                BOOL isInt = vv[NSURLVolumeIsInternalKey] ? [vv[NSURLVolumeIsInternalKey] boolValue] : NO;
                [seenNames addObject:vName];
                [volumesList addObject:@{
                    @"name": vName,
                    @"mountPoint": vPath,
                    @"total": @(vTot),
                    @"free": @(vFree),
                    @"freeStrict": @(vStr),
                    @"purgeable": @((vFree > vStr) ? (vFree - vStr) : 0),
                    @"used": @(vUsed),
                    @"isInternal": @(isInt)
                }];
            }

            root[@"disk"] = @{
                @"name": rootName,
                @"total": @(totalCap),
                @"free": @(avail),
                @"freeStrict": @(availStrict),
                @"purgeable": @(purgeable),
                @"used": @(used),
                @"volumes": volumesList
            };
        }

        // 9. Process list + Listening TCP Ports + Docker & Caffeinate status via libproc
        NSMutableArray *procsArray = [NSMutableArray array];
        NSMutableArray *portsArray = [NSMutableArray array];
        NSMutableSet *seenPortKeys = [NSMutableSet set];
        BOOL dockerRunning = NO;
        uint64_t dockerMemBytes = 0;
        NSString *dockerEngine = @"Docker";
        BOOL caffeinateActive = NO;
        pid_t caffeinatePid = 0;

        int numPids = proc_listallpids(NULL, 0);
        if (numPids > 0) {
            int cap = numPids * 2;
            pid_t *pids = (pid_t *)malloc(sizeof(pid_t) * cap);
            if (pids) {
                int actualPids = proc_listallpids(pids, sizeof(pid_t) * cap);
                mach_timebase_info_data_t tb = {1, 1};
                mach_timebase_info(&tb);
                if (tb.denom == 0) tb.denom = 1;

                pid_t selfPid = getpid();
                for (int i = 0; i < actualPids; i++) {
                    pid_t pid = pids[i];
                    if (pid <= 0 || pid == selfPid) continue;

                    char pathBuf[PROC_PIDPATHINFO_MAXSIZE] = {0};
                    NSString *fullPath = nil;
                    NSString *procName = nil;
                    if (proc_pidpath(pid, pathBuf, sizeof(pathBuf)) > 0) {
                        fullPath = [NSString stringWithUTF8String:pathBuf];
                        procName = [fullPath lastPathComponent];
                    }
                    if (!procName || procName.length == 0) {
                        char nameBuf[256] = {0};
                        if (proc_name(pid, nameBuf, sizeof(nameBuf)) > 0) {
                            procName = [NSString stringWithUTF8String:nameBuf];
                        }
                    }
                    if (!procName || procName.length == 0) continue;

                    NSString *appPath = extractAppBundlePath(fullPath);

                    uint64_t memBytes = 0;
                    uint64_t cpuNs = 0;
                    struct rusage_info_v4 ri;
                    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&ri) == 0) {
                        memBytes = ri.ri_phys_footprint;
                        uint64_t cpuTicks = ri.ri_user_time + ri.ri_system_time;
                        cpuNs = (cpuTicks * tb.numer) / tb.denom;
                    }

                    // Check if this is a Docker / OrbStack / Colima engine process
                    NSString *lowerName = [procName lowercaseString];
                    if ([lowerName isEqualToString:@"caffeinate"]) {
                        caffeinateActive = YES;
                        caffeinatePid = pid;
                    }
                    if ([lowerName containsString:@"com.docker"] ||
                        [lowerName isEqualToString:@"docker desktop"] ||
                        [lowerName isEqualToString:@"vpnkit-bridge"] ||
                        [lowerName containsString:@"orbstack"] ||
                        [lowerName containsString:@"colima"]) {
                        dockerRunning = YES;
                        dockerMemBytes += memBytes;
                        if ([lowerName containsString:@"orbstack"]) dockerEngine = @"OrbStack";
                        else if ([lowerName containsString:@"colima"]) dockerEngine = @"Colima";
                    }

                    // Scan open file descriptors of this process for listening TCP sockets
                    int fdBufSize = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
                    if (fdBufSize > 0 && fdBufSize < 1024 * 64) {
                        struct proc_fdinfo *fdInfo = (struct proc_fdinfo *)malloc(fdBufSize);
                        if (fdInfo) {
                            int actualFdBytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fdInfo, fdBufSize);
                            int fdCount = actualFdBytes / (int)sizeof(struct proc_fdinfo);
                            for (int f = 0; f < fdCount; f++) {
                                if (fdInfo[f].proc_fdtype == PROX_FDTYPE_SOCKET) {
                                    struct socket_fdinfo si;
                                    int siBytes = proc_pidfdinfo(pid, fdInfo[f].proc_fd, PROC_PIDFDSOCKETINFO, &si, sizeof(si));
                                    if (siBytes == sizeof(si)) {
                                        int fam = si.psi.soi_family;
                                        if ((fam == AF_INET || fam == AF_INET6) &&
                                            si.psi.soi_kind == SOCKINFO_TCP &&
                                            si.psi.soi_proto.pri_tcp.tcpsi_state == TSI_S_LISTEN) {
                                            uint16_t lport = ntohs((uint16_t)si.psi.soi_proto.pri_tcp.tcpsi_ini.insi_lport);
                                            if (lport > 0) {
                                                NSString *portKey = [NSString stringWithFormat:@"%u:%d", lport, pid];
                                                if (![seenPortKeys containsObject:portKey]) {
                                                    [seenPortKeys addObject:portKey];
                                                    NSString *bindAddr = @"*";
                                                    if (fam == AF_INET) {
                                                        char ipStr[INET_ADDRSTRLEN] = {0};
                                                        struct in_addr ina = si.psi.soi_proto.pri_tcp.tcpsi_ini.insi_laddr.ina_46.i46a_addr4;
                                                        if (inet_ntop(AF_INET, &ina, ipStr, sizeof(ipStr))) {
                                                            NSString *s = [NSString stringWithUTF8String:ipStr];
                                                            bindAddr = [s isEqualToString:@"0.0.0.0"] ? @"*" : s;
                                                        }
                                                    } else if (fam == AF_INET6) {
                                                        char ip6Str[INET6_ADDRSTRLEN] = {0};
                                                        struct in6_addr in6a = si.psi.soi_proto.pri_tcp.tcpsi_ini.insi_laddr.ina_6;
                                                        if (inet_ntop(AF_INET6, &in6a, ip6Str, sizeof(ip6Str))) {
                                                            NSString *s = [NSString stringWithUTF8String:ip6Str];
                                                            bindAddr = ([s isEqualToString:@"::"] || [s isEqualToString:@"0:0:0:0:0:0:0:0"]) ? @"*" : s;
                                                        }
                                                    }
                                                    [portsArray addObject:@{
                                                        @"port": @(lport),
                                                        @"pid": @(pid),
                                                        @"name": procName,
                                                        @"appPath": appPath ?: @"",
                                                        @"address": bindAddr,
                                                        @"mem": @(memBytes)
                                                    }];
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            free(fdInfo);
                        }
                    }

                    if (memBytes >= 2 * 1024 * 1024 || cpuNs >= 50000000ULL) {
                        [procsArray addObject:@{
                            @"pid": @(pid),
                            @"name": procName,
                            @"appPath": appPath ?: @"",
                            @"binPath": fullPath ?: @"",
                            @"mem": @(memBytes),
                            @"cpuNs": @(cpuNs)
                        }];
                    }
                }
                free(pids);
            }
        }
        root[@"processes"] = procsArray;
        root[@"ports"] = portsArray;
        root[@"docker"] = @{
            @"running": @(dockerRunning),
            @"memoryBytes": @(dockerMemBytes),
            @"engine": dockerEngine
        };
        root[@"caffeinate"] = @{
            @"active": @(caffeinateActive),
            @"pid": @(caffeinatePid)
        };

        // 10. Accessory & Bluetooth battery levels via IOPSCopyPowerSourcesByType + IORegistry HID
        NSMutableArray *btDevices = [NSMutableArray array];
        NSMutableSet *seenBtPartKeys = [NSMutableSet set];
        NSMutableSet *seenBtBaseNames = [NSMutableSet set];

        for (int psType = 0; psType <= 4; psType++) {
            CFTypeRef psBlob = IOPSCopyPowerSourcesByType(psType);
            if (!psBlob) continue;
            CFArrayRef psList = IOPSCopyPowerSourcesList(psBlob);
            if (psList) {
                CFIndex psCount = CFArrayGetCount(psList);
                for (CFIndex idx = 0; idx < psCount; idx++) {
                    CFTypeRef psItem = CFArrayGetValueAtIndex(psList, idx);
                    CFDictionaryRef psDescRef = IOPSGetPowerSourceDescription(psBlob, psItem);
                    if (psDescRef) {
                        NSDictionary *psDesc = (__bridge NSDictionary *)psDescRef;
                        NSString *psName = psDesc[@kIOPSNameKey];
                        NSString *psTypeStr = psDesc[@kIOPSTypeKey];
                        if (!psName || [psName hasPrefix:@"InternalBattery"] || [psTypeStr isEqualToString:@kIOPSInternalBatteryType]) {
                            continue;
                        }
                        NSString *partId = psDesc[@"Part Identifier"] ?: psDesc[@"PartIdentifier"] ?: @"Single";
                        NSString *dedupKey = [NSString stringWithFormat:@"%@::%@", psName, partId];
                        if ([seenBtPartKeys containsObject:dedupKey]) continue;

                        int curCap = [psDesc[@kIOPSCurrentCapacityKey] intValue];
                        int maxCap = [psDesc[@kIOPSMaxCapacityKey] intValue];
                        int pct = (maxCap > 0 && maxCap != 100) ? (int)round(((double)curCap / (double)maxCap) * 100.0) : curCap;
                        if (pct > 0 && pct <= 100) {
                            [seenBtPartKeys addObject:dedupKey];
                            [seenBtBaseNames addObject:psName];
                            NSString *low = [psName lowercaseString];
                            NSString *partLow = [partId lowercaseString];
                            NSString *kind = @"device";
                            if ([low containsString:@"airpods"] || [low containsString:@"soundcore"] || [low containsString:@"liberty"] || [low containsString:@"head"] || [low containsString:@"buds"] || [low containsString:@"beats"] || [low containsString:@"sony"] || [low containsString:@"audio"] || [psDesc[@"Accessory Category"] isEqual:@"Headset"] || [psDesc[@"Accessory Category"] isEqual:@"Headphones"]) {
                                kind = @"headphones";
                            } else if ([low containsString:@"mouse"] || [low containsString:@"mysz"] || [low containsString:@"ms5"] || [low containsString:@"mx"]) {
                                kind = @"mouse";
                            } else if ([low containsString:@"keyb"] || [low containsString:@"klaw"] || [low containsString:@"kb"]) {
                                kind = @"keyboard";
                            } else if ([low containsString:@"trackpad"] || [low containsString:@"gładzik"]) {
                                kind = @"trackpad";
                            } else if ([low containsString:@"watch"]) {
                                kind = @"watch";
                            }

                            NSString *displayName = psName;
                            NSString *partTag = @"single";
                            int sortOrder = 5;
                            if ([partLow containsString:@"left"]) {
                                displayName = [NSString stringWithFormat:@"%@ — Lewa (L)", psName];
                                kind = @"earbud-left";
                                partTag = @"left";
                                sortOrder = 1;
                            } else if ([partLow containsString:@"right"]) {
                                displayName = [NSString stringWithFormat:@"%@ — Prawa (P)", psName];
                                kind = @"earbud-right";
                                partTag = @"right";
                                sortOrder = 2;
                            } else if ([partLow containsString:@"case"]) {
                                displayName = [NSString stringWithFormat:@"%@ — Etui (Case)", psName];
                                kind = @"case";
                                partTag = @"case";
                                sortOrder = 3;
                            } else if ([kind isEqualToString:@"headphones"]) {
                                displayName = [NSString stringWithFormat:@"%@ (Słuchawki L+P)", psName];
                                sortOrder = 1;
                            }

                            BOOL isCharging = [psDesc[@kIOPSIsChargingKey] boolValue];
                            [btDevices addObject:@{
                                @"name": displayName,
                                @"baseName": psName,
                                @"part": partTag,
                                @"sortOrder": @(sortOrder),
                                @"connected": @(YES),
                                @"charging": @(isCharging),
                                @"percent": @(pct),
                                @"kind": kind
                            }];
                        }
                    }
                }
                CFRelease(psList);
            }
            CFRelease(psBlob);
        }

        // Also scan IORegistry HID devices with BatteryPercent (Magic Mouse, Magic Keyboard, Logitech, AirPods, etc.)
        io_iterator_t hidIter = 0;
        if (IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOService"), &hidIter) == KERN_SUCCESS) {
            io_object_t serv;
            while ((serv = IOIteratorNext(hidIter))) {
                CFTypeRef prodRef = IORegistryEntryCreateCFProperty(serv, CFSTR("Product"), kCFAllocatorDefault, 0);
                NSString *prodName = (prodRef && CFGetTypeID(prodRef) == CFStringGetTypeID())
                    ? [NSString stringWithString:(__bridge NSString *)prodRef]
                    : nil;
                if (prodRef) CFRelease(prodRef);

                if (prodName && prodName.length > 0) {
                    // Check for multi-battery HID properties (BatteryPercentLeft, BatteryPercentRight, BatteryPercentCase, BatteryPercent)
                    NSDictionary *partProps = @{
                        @"Left": @"BatteryPercentLeft",
                        @"Right": @"BatteryPercentRight",
                        @"Case": @"BatteryPercentCase",
                        @"Single": @"BatteryPercent"
                    };
                    for (NSString *pKey in @[@"Left", @"Right", @"Case", @"Single"]) {
                        NSString *propName = partProps[pKey];
                        CFTypeRef bpRef = IORegistryEntryCreateCFProperty(serv, (__bridge CFStringRef)propName, kCFAllocatorDefault, 0);
                        if (!bpRef) continue;
                        int pct = 0;
                        if (CFGetTypeID(bpRef) == CFNumberGetTypeID()) {
                            CFNumberGetValue((CFNumberRef)bpRef, kCFNumberIntType, &pct);
                        }
                        CFRelease(bpRef);
                        if (pct > 0 && pct <= 100) {
                            NSString *dedupKey = [NSString stringWithFormat:@"%@::%@", prodName, pKey];
                            if ([pKey isEqualToString:@"Single"] && [seenBtBaseNames containsObject:prodName]) continue;
                            if ([seenBtPartKeys containsObject:dedupKey]) continue;
                            [seenBtPartKeys addObject:dedupKey];
                            [seenBtBaseNames addObject:prodName];

                            NSString *low = [prodName lowercaseString];
                            NSString *kind = @"device";
                            if ([low containsString:@"mouse"] || [low containsString:@"mysz"]) kind = @"mouse";
                            else if ([low containsString:@"keyb"] || [low containsString:@"klaw"]) kind = @"keyboard";
                            else if ([low containsString:@"trackpad"] || [low containsString:@"gładzik"]) kind = @"trackpad";
                            else if ([low containsString:@"airpods"] || [low containsString:@"head"] || [low containsString:@"soundcore"] || [low containsString:@"buds"] || [low containsString:@"beats"] || [low containsString:@"sony"]) kind = @"headphones";

                            NSString *displayName = prodName;
                            NSString *partTag = @"single";
                            int sortOrder = 5;
                            if ([pKey isEqualToString:@"Left"]) {
                                displayName = [NSString stringWithFormat:@"%@ — Lewa (L)", prodName];
                                kind = @"earbud-left";
                                partTag = @"left";
                                sortOrder = 1;
                            } else if ([pKey isEqualToString:@"Right"]) {
                                displayName = [NSString stringWithFormat:@"%@ — Prawa (P)", prodName];
                                kind = @"earbud-right";
                                partTag = @"right";
                                sortOrder = 2;
                            } else if ([pKey isEqualToString:@"Case"]) {
                                displayName = [NSString stringWithFormat:@"%@ — Etui (Case)", prodName];
                                kind = @"case";
                                partTag = @"case";
                                sortOrder = 3;
                            }

                            [btDevices addObject:@{
                                @"name": displayName,
                                @"baseName": prodName,
                                @"part": partTag,
                                @"sortOrder": @(sortOrder),
                                @"connected": @(YES),
                                @"charging": @(NO),
                                @"percent": @(pct),
                                @"kind": kind
                            }];
                        }
                    }
                }
                IOObjectRelease(serv);
            }
            IOObjectRelease(hidIter);
        }

        [btDevices sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
            return [a[@"sortOrder"] compare:b[@"sortOrder"]];
        }];

        // If a connected Bluetooth headset only reports a single HFP battery ("part": "single")
        // without separate Left/Right entries, emit Left (L) and Right (P) earbud entries
        // so both earbuds are represented in the battery rings.
        NSMutableSet *multiPartHeadsets = [NSMutableSet set];
        for (NSDictionary *d in btDevices) {
            NSString *p = d[@"part"];
            if ([p isEqualToString:@"left"] || [p isEqualToString:@"right"] || [p isEqualToString:@"case"]) {
                if (d[@"baseName"]) [multiPartHeadsets addObject:d[@"baseName"]];
            }
        }

        NSMutableArray *expandedBtDevices = [NSMutableArray array];
        for (NSDictionary *d in btDevices) {
            NSString *base = d[@"baseName"] ?: d[@"name"];
            if ([d[@"kind"] isEqualToString:@"headphones"] &&
                [d[@"part"] isEqualToString:@"single"] &&
                ![multiPartHeadsets containsObject:base]) {
                [expandedBtDevices addObject:@{
                    @"name": [NSString stringWithFormat:@"%@ — Lewa (L)", base],
                    @"baseName": base,
                    @"part": @"left",
                    @"hfpShared": @(YES),
                    @"sortOrder": @(1),
                    @"connected": d[@"connected"],
                    @"charging": d[@"charging"],
                    @"percent": d[@"percent"],
                    @"kind": @"earbud-left"
                }];
                [expandedBtDevices addObject:@{
                    @"name": [NSString stringWithFormat:@"%@ — Prawa (P)", base],
                    @"baseName": base,
                    @"part": @"right",
                    @"hfpShared": @(YES),
                    @"sortOrder": @(2),
                    @"connected": d[@"connected"],
                    @"charging": d[@"charging"],
                    @"percent": d[@"percent"],
                    @"kind": @"earbud-right"
                }];
                [expandedBtDevices addObject:@{
                    @"name": [NSString stringWithFormat:@"%@ — Etui (Case)", base],
                    @"baseName": base,
                    @"part": @"case",
                    @"hfpShared": @(YES),
                    @"sortOrder": @(3),
                    @"connected": d[@"connected"],
                    @"charging": d[@"charging"],
                    @"percent": d[@"percent"],
                    @"kind": @"case"
                }];
            } else {
                [expandedBtDevices addObject:d];
            }
        }
        root[@"bluetooth"] = expandedBtDevices;

        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:root options:0 error:nil];
        if (jsonData) {
            fwrite(jsonData.bytes, 1, jsonData.length, stdout);
            fwrite("\n", 1, 1, stdout);
        }
    }
    return 0;
}
