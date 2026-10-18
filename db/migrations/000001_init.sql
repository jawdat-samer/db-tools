-- ============================================================
-- 001_init.sql
-- ============================================================
SET
  FOREIGN_KEY_CHECKS = 0;

-- ---------- User ----------
CREATE TABLE
  IF NOT EXISTS `User` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(300) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `email` VARCHAR(255) NULL,
    `photo` VARCHAR(300) NOT NULL DEFAULT 'default.webp',
    `password` VARCHAR(255) NOT NULL,
    `passwordUpdatedAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `passwordResetToken` VARCHAR(255) NULL,
    `passwordResetExpiresAt` TIMESTAMP(3) NULL,
    `isActive` TINYINT (1) NOT NULL DEFAULT 1,
    `roleId` INT NOT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `User_phone_key` (`phone`),
    UNIQUE KEY `User_email_key` (`email`),
    INDEX `User_roleId_idx` (`roleId`),
    INDEX `User_isActive_idx` (`isActive`),
    INDEX `User_email_idx` (`email`),
    INDEX `User_phone_idx` (`phone`),
    CONSTRAINT `User_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role` (`id`) ON UPDATE CASCADE ON DELETE RESTRICT
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

SET
  FOREIGN_KEY_CHECKS = 1;