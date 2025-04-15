-- 训练数据集表
CREATE TABLE IF NOT EXISTS `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(255) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb3;

CREATE TABLE IF NOT EXISTS `folders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `parent_id` int DEFAULT NULL,
  `user_id` int NOT NULL,
  `is_root` tinyint(1) DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_folder_name` (`name`,`parent_id`,`user_id`),
  KEY `parent_id` (`parent_id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `folders_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `folders_ibfk_1` FOREIGN KEY (`parent_id`) REFERENCES `folders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=44 DEFAULT CHARSET=utf8mb3;

CREATE TABLE IF NOT EXISTS `images` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `file_path` varchar(255) NOT NULL,
  `s3_url` varchar(255) DEFAULT NULL,
  `user_id` int NOT NULL,
  `folder_id` int DEFAULT NULL,
  `size` bigint NOT NULL,
  `mime_type` varchar(100) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `folder_id` (`folder_id`),
  CONSTRAINT `images_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `images_ibfk_2` FOREIGN KEY (`folder_id`) REFERENCES `folders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=520 DEFAULT CHARSET=utf8mb3;

CREATE TABLE IF NOT EXISTS `training_datasets` (
  `id` VARCHAR(36) NOT NULL,
  `user_id` INT NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `description` TEXT NULL,
  `s3_prefix` VARCHAR(255) NOT NULL,
  `image_count` INT DEFAULT 0,
  `status` ENUM('uploading', 'ready', 'training', 'error') NOT NULL DEFAULT 'uploading',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_user_id` (`user_id`),
  CONSTRAINT `fk_dataset_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 微调模型表
CREATE TABLE IF NOT EXISTS `clip_models` (
  `id` VARCHAR(36) NOT NULL,
  `user_id` INT NOT NULL,
  `dataset_id` VARCHAR(36) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `s3_path` VARCHAR(255) NOT NULL,
  `status` ENUM('training', 'ready', 'deploying', 'error', 'deleted') NOT NULL DEFAULT 'training',
  `endpoint_name` VARCHAR(100) NULL,
  `endpoint_status` VARCHAR(50) NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_dataset_id` (`dataset_id`),
  CONSTRAINT `fk_model_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_model_dataset` FOREIGN KEY (`dataset_id`) REFERENCES `training_datasets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4; 
